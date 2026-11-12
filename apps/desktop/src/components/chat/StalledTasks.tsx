import { X } from "lucide-react";

import { PartyChip } from "@/components/chat/BotTranscript";
import { MergeControl } from "@/components/TasksPanel";
import { Button } from "@/components/ui/button";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import type { CrewRow } from "@/lib/crew";
import { isModClick } from "@/lib/platform";
import { readyToMerge } from "@/lib/pr";
import { stalledFor, type Stall } from "@/lib/stalled";
import type { MergeMethod, PrMark } from "@/types/events";

/// Dismissed stalls, by key. A key names one stall, so the list only grows by
/// what the reader dismisses; the cap keeps a long life from filling the store.
const DISMISSED_KEY = "ade.dismissedStalls";
const DISMISSED_CAP = 200;

/// The foot of a bot's chat while any of its tasks has sat untouched for
/// [STALL_MS]: each one and what it needs, with Merge where its pull request is
/// ready. Drawn by the app from the tasks' own state, so the bot writes
/// nothing and a stall clears itself the moment the task moves. Dismissed, a
/// stall stays gone until the task changes and stalls again.
export default function StalledTasks({
  stalls,
  now,
  onOpen,
  onMerge,
}: {
  stalls: readonly Stall[];
  now: number;
  /// `alone`: a ⌘-click, which switches to the task rather than opening its tab.
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  const [dismissed, setDismissed] = useLocalStorage<string[]>(DISMISSED_KEY, []);
  const shown = stalls.filter((s) => !dismissed.includes(s.key));
  if (shown.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-1 rounded-xl border border-border/60 px-3 py-2">
      <div className="flex items-center text-ui text-muted-foreground">
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
      {shown.map((stall) => {
        const { row, pr } = stall;
        const id = row.item.sessionId;
        const mergeable = stall.kind === "ready" && pr && readyToMerge(pr) === true;
        return (
          <div key={stall.key} className="flex min-h-8 items-center gap-2 text-ui">
            <PartyChip parties={[{ id, title: row.item.title }]} onClick={(e) => onOpen(id, isModClick(e))} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {stall.kind === "ready" && pr
                ? `PR #${pr.number} ready for ${stalledFor(stall.since, now)}`
                : `Idle, waiting on you for ${stalledFor(stall.since, now)}`}
            </span>
            {mergeable && <MergeControl onMerge={(method) => onMerge(row, pr, method)} />}
            <Button variant="ghost" size="xs" onClick={(e) => onOpen(id, isModClick(e))}>
              Open
            </Button>
          </div>
        );
      })}
    </div>
  );
}
