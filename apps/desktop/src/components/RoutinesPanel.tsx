import { Clock, Pause, Play, Trash2, Zap } from "lucide-react";
import { useState } from "react";

import { RowAction } from "@/components/Sidebar";
import { lastRunFailed, lastRunLabel, nextRunLabel, scheduleLabel } from "@/lib/routines";
import { cn } from "@/lib/utils";
import type { Routine } from "@/types/events";

/// A bot's Routines tab (#972): the scheduled checks it made for itself. The
/// reader sees each one's schedule, next run and last result here, and pauses
/// or deletes what they don't want; a click opens what it does each run.
export default function RoutinesPanel({
  routines,
  now,
  onPause,
  onDelete,
  onRunNow,
  error,
}: {
  routines: Routine[];
  /// The clock "next in" is read against, ticking once a minute.
  now: number;
  onPause: (id: string, paused: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRunNow: (id: string) => Promise<void>;
  /// Why the last Pause, Resume, Run now or Delete failed.
  error?: string | null;
}) {
  const failed = error && <p className="px-3 pb-1 text-ui text-destructive/80">{error}</p>;
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-2">
      {failed}
      {routines.map((r) => (
        <RoutineRow
          key={r.id}
          routine={r}
          now={now}
          onPause={onPause}
          onDelete={onDelete}
          onRunNow={onRunNow}
        />
      ))}
    </div>
  );
}

function RoutineRow({
  routine,
  now,
  onPause,
  onDelete,
  onRunNow,
}: {
  routine: Routine;
  now: number;
  onPause: (id: string, paused: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRunNow: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const last = lastRunLabel(routine);
  const { id, paused } = routine;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setOpen((o) => !o)}
      className="group flex w-full cursor-pointer flex-col rounded-md px-2 py-1.5 text-left text-ui text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-6 items-center gap-2">
        <span className={cn("flex size-5 shrink-0 items-center justify-center", paused && "opacity-50")}>
          {paused ? <Pause className="size-3.5" /> : <Clock className="size-3.5" />}
        </span>
        <span className="relative flex min-w-0 flex-1 items-center">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-foreground",
              paused && "text-muted-foreground",
              "row-reached:[mask-image:linear-gradient(to_left,transparent_76px,black_100px)]",
            )}
          >
            {routine.name}
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 row-reached:pointer-events-auto row-reached:opacity-100">
            <RowAction label="Run now" active={false} onClick={() => void onRunNow(id)}>
              <Zap />
            </RowAction>
            <RowAction label={paused ? "Resume" : "Pause"} active={false} onClick={() => void onPause(id, !paused)}>
              {paused ? <Play /> : <Pause />}
            </RowAction>
            <RowAction label="Delete" active={false} onClick={() => void onDelete(id)}>
              <Trash2 />
            </RowAction>
          </span>
        </span>
      </span>
      {/* Under the name, past the icon's 20px and the 8px gap. */}
      <span className="truncate pl-7 text-foreground/60">
        {scheduleLabel(routine)} · {nextRunLabel(routine, now)}
      </span>
      {last && (
        <span
          className={cn("flex min-w-0 gap-1 pl-7", lastRunFailed(routine) ? "text-destructive/80" : "text-foreground/50")}
          title={last.text}
        >
          <span className="min-w-0 truncate">{last.text}</span>
          {last.age && <span className="shrink-0">· {last.age}</span>}
        </span>
      )}
      {open && (
        <span className="mt-1.5 flex flex-col gap-1.5 pl-7 text-foreground/70">
          <span className="whitespace-pre-wrap">{routine.prompt}</span>
          {routine.check && (
            <span className="text-foreground/50">
              Wakes the bot only when <code className="font-mono text-[12px]">{routine.check}</code> prints something new.
            </span>
          )}
        </span>
      )}
    </div>
  );
}
