import { X } from "lucide-react";
import { useState } from "react";

import BotAvatar from "@/components/BotAvatar";
import PrStateIcon, { prStateLabel } from "@/components/PrStateIcon";
import { MergeControl } from "@/components/TasksPanel";
import { Button } from "@/components/ui/button";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { seededAvatar } from "@/lib/botAvatar";
import { previewLine } from "@/lib/bots";
import type { CrewRow } from "@/lib/crew";
import { isModClick } from "@/lib/platform";
import { mergeVerdict, readyToMerge } from "@/lib/pr";
import { compactAge, type Stall } from "@/lib/stalled";
import { cn } from "@/lib/utils";
import type { BotPreview, MergeMethod, PrMark } from "@/types/events";

/// Dismissed stalls, by key. A key names one stall, so the list only grows by
/// what the reader dismisses; the cap keeps a long life from filling the store.
const DISMISSED_KEY = "ade.dismissedStalls";
const DISMISSED_CAP = 200;

/// The foot of a bot's chat while any of its tasks has sat untouched for
/// `STALL_MS`: an inbox row per task — its face, title, PR, how long since its
/// last message, and that message — so the reader sees what each waits on
/// without opening it. A click opens the task; Merge lands a ready PR in
/// place. Drawn from the tasks' own state, so the bot writes nothing and a row
/// clears the moment its task moves. Dismissed, a stall stays gone until the
/// task changes and stalls again.
export default function StalledTasks({
  stalls,
  previews,
  now,
  lines = 1,
  onOpen,
  onMerge,
}: {
  stalls: readonly Stall[];
  /// Each task's last message, by session id.
  previews: Readonly<Record<string, BotPreview>>;
  now: number;
  /// How much of the last message a row shows.
  lines?: 1 | 2;
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
        <StalledRow
          key={stall.key}
          stall={stall}
          preview={previews[stall.row.item.sessionId]?.text}
          now={now}
          lines={lines}
          onOpen={onOpen}
          onMerge={onMerge}
        />
      ))}
    </div>
  );
}

/// One task as the old inbox bot row drew a chat: face, name and time on top,
/// the last message under it.
function StalledRow({
  stall,
  preview,
  now,
  lines,
  onOpen,
  onMerge,
}: {
  stall: Stall;
  preview: string | null | undefined;
  now: number;
  lines: 1 | 2;
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  const [hovered, setHovered] = useState(false);
  const { row, pr } = stall;
  const { item } = row;
  const id = item.sessionId;
  const open = (e: React.MouseEvent | React.KeyboardEvent) => onOpen(id, isModClick(e));
  const mergeable = stall.kind === "ready" && pr && readyToMerge(pr) === true;

  return (
    // A div, since a button cannot hold Merge inside it.
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(e)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BotAvatar seed={id} avatar={seededAvatar(id)} follow={hovered} className="block size-8 shrink-0 scale-[1.18]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-ui text-foreground">{item.title}</span>
          {pr && (
            <span
              className={cn("flex shrink-0 items-center gap-0.5 self-center text-[12px] tabular-nums", prTone(pr))}
              title={`Pull request #${pr.number} · ${prStateLabel(pr).toLowerCase()}`}
            >
              <PrStateIcon pr={pr} strokeWidth={1.5} className="text-current" />#{pr.number}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
            {compactAge(item.modified, now)}
          </span>
        </span>
        {preview && (
          <span className={cn("text-ui text-muted-foreground", lines === 1 ? "truncate" : "line-clamp-2")}>
            {previewLine(preview)}
          </span>
        )}
      </span>
      {mergeable && <MergeControl onMerge={(method) => onMerge(row, pr, method)} />}
    </div>
  );
}

/// The PR mark's colour: green when it can land, red when something is in
/// its way, quiet while it waits on CI or a review. Swap for `prStatus(pr)`
/// and its tone once #926 lands, which says the same of every PR.
function prTone(pr: PrMark): string {
  if (pr.state === "OPEN" && pr.checksState === "FAILING") return "text-destructive";
  switch (mergeVerdict(pr)) {
    case "ready":
      return "text-accent-add";
    case "merged":
      return "text-accent-merged";
    case "closed":
    case "conflict":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}
