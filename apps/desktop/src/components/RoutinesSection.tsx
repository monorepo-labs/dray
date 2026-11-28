import { useId, useState } from "react";
import { ArrowLeft, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input, inputClassName } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nextRunLabel, scheduleLabel } from "@/lib/routines";
import { cn } from "@/lib/utils";
import type { Routine } from "@/types/events";

type RoutineActions = {
  /// The clock "next in" is read against, ticking once a minute.
  now: number;
  onPause: (id: string, paused: boolean) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onSave: (id: string, name: string, prompt: string) => Promise<boolean>;
  /// Why the last switch, Delete or Save failed.
  error?: string | null;
};

/// A bot's routines (#972), a section of the More tab: a card per scheduled
/// check it made for itself, with its schedule and next run. The reader turns
/// one off with its switch, deletes it from the right-click menu, and clicks
/// it to read and edit it in [RoutineDetails] (#1637). Drawn only with a
/// routine in it, as every More section is.
export default function RoutinesSection({
  routines,
  now,
  onPause,
  onDelete,
  onOpen,
  error,
}: Omit<RoutineActions, "onSave"> & {
  routines: Routine[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="shrink-0">
      {/* The heading `RunHeading` draws over Background tasks and Subagents. */}
      <div className="px-3 pt-4 pb-2 text-ui text-muted-foreground">Routines</div>
      {error && <p className="px-3 pb-2 text-ui text-destructive/80">{error}</p>}
      <div className="flex flex-col gap-2 px-2 pb-3">
        {routines.map((r) => (
          <RoutineCard
            key={r.id}
            routine={r}
            now={now}
            onPause={onPause}
            onDelete={onDelete}
            onOpen={() => onOpen(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RoutineCard({
  routine,
  now,
  onPause,
  onDelete,
  onOpen,
}: {
  routine: Routine;
  now: number;
  onPause: (id: string, paused: boolean) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onOpen: () => void;
}) {
  const { id, paused } = routine;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-label={`Open ${routine.name}`}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onOpen();
            }
          }}
          className="flex cursor-pointer items-center gap-3 rounded-xl border-[0.5px] border-border bg-card px-3 py-2.5 text-ui transition-colors outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Clock className={cn("size-4 shrink-0 text-muted-foreground", paused && "opacity-50")} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={cn("truncate", paused ? "text-muted-foreground" : "text-foreground")}>{routine.name}</span>
            <span className="truncate text-foreground/60">
              {scheduleLabel(routine)} · {nextRunLabel(routine, now)}
            </span>
          </div>
          {/* The card opens on a click, so the switch keeps its own. */}
          <Switch
            checked={!paused}
            onClick={(e) => e.stopPropagation()}
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

/// One routine, drawn over the whole More tab in place of its sections: name
/// and instructions to edit, the schedule to read. Edits are kept here until
/// Save, so a bot changing the routine meanwhile shows through only on fields
/// the reader has not touched.
export function RoutineDetails({
  routine,
  now,
  onSave,
  onBack,
  error,
}: Pick<RoutineActions, "now" | "onSave" | "error"> & {
  routine: Routine;
  onBack: () => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  const promptId = useId();
  const shownName = name ?? routine.name;
  const shownPrompt = prompt ?? routine.prompt;
  const changed = shownName.trim() !== routine.name || shownPrompt.trim() !== routine.prompt;
  const valid = shownName.trim() !== "" && shownPrompt.trim() !== "";

  const save = async () => {
    if (!changed || !valid || saving) return;
    setSaving(true);
    const ok = await onSave(routine.id, shownName, shownPrompt);
    setSaving(false);
    if (ok) {
      setName(null);
      setPrompt(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2.5 pb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack}>
              <ArrowLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back</TooltipContent>
        </Tooltip>
        <span className="text-ui text-muted-foreground">Routines</span>
      </div>
      <form
        className="flex flex-col gap-4 px-3 pt-2 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-ui text-muted-foreground">
            Name
          </label>
          <Input
            id={nameId}
            value={shownName}
            onChange={(e) => setName(e.target.value)}
            className="text-ui md:text-ui"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={promptId} className="text-ui text-muted-foreground">
            Instructions
          </label>
          {/* Grows with its text up to most of the pane, since a routine's
              prompt is usually a paragraph or a checklist. */}
          <textarea
            id={promptId}
            value={shownPrompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            className={cn(
              inputClassName,
              "field-sizing-content h-auto max-h-[60vh] min-h-28 resize-none py-1.5 text-ui md:text-ui",
            )}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-ui text-muted-foreground">Schedule</span>
          <span className="text-ui text-foreground">
            {scheduleLabel(routine)} · {nextRunLabel(routine, now)}
          </span>
        </div>
        {error && <p className="text-ui text-destructive/80">{error}</p>}
        <div className="flex justify-end gap-2">
          {changed && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setName(null);
                setPrompt(null);
              }}
            >
              Discard
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!changed || !valid || saving}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
