import { Clock } from "lucide-react";

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Switch } from "@/components/ui/switch";
import { lastRunFailed, lastRunLabel, nextRunLabel, scheduleLabel } from "@/lib/routines";
import { cn } from "@/lib/utils";
import type { Routine } from "@/types/events";

/// A bot's Routines tab (#972): a card per scheduled check it made for itself,
/// with its schedule, next run and last result. The reader turns one off with
/// its switch and deletes it from the right-click menu; anything else — what
/// it does, running it, changing it — they ask the bot for.
export default function RoutinesPanel({
  routines,
  now,
  onPause,
  onDelete,
  error,
}: {
  routines: Routine[];
  /// The clock "next in" is read against, ticking once a minute.
  now: number;
  onPause: (id: string, paused: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /// Why the last switch or Delete failed.
  error?: string | null;
}) {
  const failed = error && <p className="px-1 pb-1 text-ui text-destructive/80">{error}</p>;
  if (routines.length === 0) {
    return (
      <div className="py-2">
        {failed}
        <p className="px-4 py-4 text-ui text-muted-foreground">
          No routines yet. Ask this bot to check on something on a schedule, like “tell me when CI on my PR goes green”.
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-2">
      {failed}
      {routines.map((r) => (
        <RoutineCard key={r.id} routine={r} now={now} onPause={onPause} onDelete={onDelete} />
      ))}
    </div>
  );
}

function RoutineCard({
  routine,
  now,
  onPause,
  onDelete,
}: {
  routine: Routine;
  now: number;
  onPause: (id: string, paused: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const last = lastRunLabel(routine);
  const { id, paused } = routine;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-3 rounded-xl bg-card px-3 py-2.5 text-ui shadow-(--shadow-card)">
          <Clock className={cn("size-4 shrink-0 text-muted-foreground", paused && "opacity-50")} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={cn("truncate", paused ? "text-muted-foreground" : "text-foreground")}>{routine.name}</span>
            <span className="truncate text-foreground/60">
              {scheduleLabel(routine)} · {nextRunLabel(routine, now)}
            </span>
            {last && (
              <span
                className={cn("flex min-w-0 gap-1", lastRunFailed(routine) ? "text-destructive/80" : "text-foreground/50")}
                title={last.text}
              >
                <span className="min-w-0 truncate">{last.text}</span>
                {last.age && <span className="shrink-0">· {last.age}</span>}
              </span>
            )}
          </div>
          <Switch
            checked={!paused}
            onCheckedChange={(on) => void onPause(id, !on)}
            aria-label={paused ? `Turn on ${routine.name}` : `Turn off ${routine.name}`}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem className="text-ui text-destructive" onSelect={() => void onDelete(id)}>
          Delete routine
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
