import { useEffect, useRef } from "react";
import { ChevronRight, Square } from "lucide-react";

import EventRow from "@/components/chat/EventRow";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { compactTokens } from "@/lib/format";
import type { SubagentRun } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import type { ToolResult } from "@/types/events";

type SubagentPanelProps = {
  runs: SubagentRun[];
  /// The expanded run, or null with everything collapsed. Owned by `App`
  /// because a click in the chat opens a run from outside this component.
  selectedId: string | null;
  resultByCallId: Map<string, ToolResult>;
  /// Whether a child is actually running this session. A run left open by a
  /// killed child looks unfinished forever, and its task died with the process
  /// — so the stop button is withheld rather than offered and then erroring.
  live: boolean;
  onSelect: (id: string | null) => void;
  onStopTask: (taskId: string) => void;
};

/// Every subagent in the session, one row each, expanding in place. A tab of
/// [RightPanel](./RightPanel.tsx), which owns the frame — this is the body only.
///
/// Shaped like [ChangesPanel](./ChangesPanel.tsx) rather than as a list above a
/// detail pane: a fixed-height list gave the runs a few rows to live in however
/// much space the pane had, and the split meant one run was always open whether
/// or not the reader asked for it.
///
/// Newest first, ordered by [buildTranscript](@/lib/transcript). The running run
/// is the one with a decision attached to it, and it is always the newest.
export default function SubagentPanel({
  runs,
  selectedId,
  resultByCallId,
  live,
  onSelect,
  onStopTask,
}: SubagentPanelProps) {
  if (runs.length === 0) {
    return (
      <p className="px-3 py-6 text-ui text-muted-foreground">No subagents in this session.</p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          open={run.id === selectedId}
          resultByCallId={resultByCallId}
          live={live}
          onToggle={() => onSelect(run.id === selectedId ? null : run.id)}
          onStopTask={onStopTask}
        />
      ))}
    </div>
  );
}

/// One run: what it is doing on the row, what it did underneath.
///
/// No icon and no tool name. Every row here is a subagent, so an icon repeated
/// down the list distinguishes nothing, and the name is the harness's word for
/// the mechanism ("Task", "local_bash") rather than for the work.
function RunRow({
  run,
  open,
  resultByCallId,
  live,
  onToggle,
  onStopTask,
}: {
  run: SubagentRun;
  open: boolean;
  resultByCallId: Map<string, ToolResult>;
  live: boolean;
  onToggle: () => void;
  onStopTask: (taskId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Opening a run from the chat scrolls it into view — the panel keeps its own
  // scroll position across sessions and tabs, so the row a click just opened is
  // routinely off-screen. `nearest` leaves an already-visible row where it is.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const detail =
    (run.done ? run.description : run.status ?? run.description) ??
    run.label ??
    "Subagent";

  const tokens = run.usage?.totalTokens ?? null;

  // Only a run the harness still holds can be stopped. `taskId` is null until a
  // lifecycle event names it, and a dead child's tasks died with it — either way
  // the button would be one the CLI answers success to and nothing happens.
  const stoppable = live && !run.done && run.taskId !== null;

  return (
    <div ref={ref} className="border-b border-border">
      {/* A row, not one button: the stop control is a second action on the same
          line, and nesting it inside the expander would be a button inside a
          button. The expander keeps the row's padding so its hit area is still
          the whole line minus the control. */}
      <div className="flex items-center transition-colors hover:bg-sidebar-accent/50">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left text-ui"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />

          {/* The shimmer stands in for the orb the chat row carries: at this text
              size the orb is taller than the row it sits in, and a list of them
              animating at once is the panel's loudest element. */}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              run.done ? "text-sidebar-foreground" : "shimmer-text",
            )}
          >
            {detail}
          </span>

          {tokens != null && (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {compactTokens(tokens)}
            </span>
          )}
        </button>

        {/* Shown rather than revealed on hover: a task running longer than it
            should is what sends the reader here, and a control they have to
            find by pointing at the right row is one more thing between them and
            stopping it. Settled runs draw nothing, so the column is only as
            loud as the session is busy. */}
        {stoppable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Stop this subagent"
                className="mr-2 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => onStopTask(run.taskId!)}
              >
                <Square className="fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop this subagent</TooltipContent>
          </Tooltip>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
          {/* The spawning call first: its arguments are the prompt this run was
              given, and its result the report it came back with. For a
              background `Bash` it is the *only* content there is — such a task
              files no events of its own, so without this the row opened onto
              nothing. Expanded on arrival: it is what the reader opened the run
              for, and a second click to reach it reveals nothing they hadn't
              already asked for. */}
          {run.spawn && (
            <EventRow event={run.spawn} resultByCallId={resultByCallId} openTool />
          )}

          {run.events.map((event) => (
            <EventRow key={event.id} event={event} resultByCallId={resultByCallId} />
          ))}
        </div>
      )}
    </div>
  );
}
