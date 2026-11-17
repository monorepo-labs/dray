import { SignalSlashIcon } from "@heroicons/react/16/solid";
import { ArrowUpRight, MousePointerClick, X } from "lucide-react";
import { useState } from "react";

import BotAvatar from "@/components/BotAvatar";
import BotReply from "@/components/chat/BotReply";
import { TONE_TEXT } from "@/components/PrPanel";
import PrStateIcon from "@/components/PrStateIcon";
import { MergeControl } from "@/components/TasksPanel";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { seededAvatar } from "@/lib/botAvatar";
import type { CrewRow } from "@/lib/crew";
import { IS_MAC, isModClick } from "@/lib/platform";
import { prStatus } from "@/lib/pr";
import { offlineLine, useServers } from "@/lib/servers";
import { cardRows, compactAge, DISMISSED_KEY, needLine, type Stall } from "@/lib/stalled";
import { serverOfPath } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { MergeMethod, PrMark } from "@/types/events";

/// Keeps a long life from filling the store with dismissed stalls.
const DISMISSED_CAP = 200;

/// Rows drawn before "Show N more", so a long card doesn't push the chat off screen.
const ROWS_SHOWN = 5;

/// The foot of a bot's chat while any of its tasks waits on the reader: an
/// inbox row per task — its face, title, PR and how long it has sat. A PR
/// ready to merge carries Merge; a task idle on the reader carries the line its
/// bot wrote for it (`dray session need`), and so does a ready PR the task
/// asked the reader to try first. A click opens, under the row, what the bot
/// said about the task: its reply to the task's last report, which the bot's
/// server finds walking back from the end of its chat. A second click closes
/// it; with no reply, the click opens the task. The task's own message is never
/// shown, being written for the bot. ⌘-click and Open, shown on hover, open the
/// task in a tab. A row clears the moment its task moves;
/// dismissed, a stall stays gone until the task changes and stalls again. A
/// task whose machine is down stays, drawn from what was last known with the
/// offline mark in its time's place and nothing to open; Merge still works,
/// through GitHub from here, where `mergeBlock` allows it, and the offline mark
/// says why where it does not.
export default function StalledTasks({
  stalls,
  now,
  onOpen,
  onMerge,
  mergeBlock,
}: {
  /// The card's rows: `onCard` stalls alone.
  stalls: readonly Stall[];
  now: number;
  /// `alone`: a ⌘-click, which switches to the task rather than opening its tab.
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
  /// Why a ready row offers no Merge, or `null` where it does.
  mergeBlock: (row: CrewRow, pr: PrMark) => string | null;
}) {
  const [dismissed, setDismissed] = useLocalStorage<string[]>(DISMISSED_KEY, []);
  // Each row's offline mark follows its machine.
  useServers();
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
          mergeBlock={mergeBlock}
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
/// under it where its bot wrote that; most ready PRs never get a line at all.
/// Expanded, the bot's reply to the task's last report sits under it, or, with
/// none, the row closes and the task opens.
function StalledRow({
  stall,
  now,
  expanded,
  onToggle,
  onOpen,
  onMerge,
  mergeBlock,
}: {
  stall: Stall;
  now: number;
  expanded: boolean;
  onToggle: (sessionId: string) => void;
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
  const offline = offlineLine(serverOfPath(item.cwd));
  const blocked = stall.kind === "ready" && pr && !stall.checking ? mergeBlock(row, pr) : null;

  return (
    <div className={cn("flex flex-col rounded-lg", expanded && "bg-muted/30")}>
      {/* A div, since a button cannot hold Open task and Merge inside it. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={(e) => (isModClick(e) && !offline ? onOpen(id, false) : onToggle(id))}
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
              {/* Half strength: it sits on every row the pointer crosses. A
                  task whose machine is down has nothing to open. */}
              {!offline && (
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
          ) : expanded || !waiting ? null : (
            <span className="min-w-0 truncate text-ui text-muted-foreground">Waiting for your reply</span>
          )}
        </span>
      </div>
      {expanded && (
        <div className="pr-3 pb-3 pl-[52px] text-ui">
          {/* A task whose machine is down cannot open, so its row stays and says so. */}
          <BotReply
            taskId={id}
            onNone={() => {
              if (offline) return;
              onToggle(id);
              onOpen(id, false);
            }}
          />
        </div>
      )}
    </div>
  );
}
