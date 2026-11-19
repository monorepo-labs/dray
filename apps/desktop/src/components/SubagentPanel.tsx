import { useEffect, useRef } from "react";
import { ArrowUpRight, Check, ChevronRight, Square, SquareTerminal } from "lucide-react";

import Orb from "@/components/Orb";
import EventRow from "@/components/chat/EventRow";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { subagentBrief } from "@/lib/tools";
import { canOpenTab, isShellRun, opensTab, type SubagentRun } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import type { AgentEvent, ToolResult } from "@/types/events";

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
  /// Opens a subagent's conversation as a tab of the row. Absent where the
  /// panel's session has no row of its own, and then every run expands.
  onOpen?: (run: SubagentRun) => void;
  onStopTask: (taskId: string) => void;
};

/// The session's background shells and subagents, as two titled sections of
/// [MorePanel](./MorePanel.tsx). A section with no rows draws nothing, heading
/// included — the tab is a catch-all whose sections come and go. Finished
/// shells are dropped before they get here, see `runningRuns`; finished
/// subagents stay, since their conversation is still worth opening.
///
/// Flat rows with no card or fill of their own, rather than one list above a
/// detail pane: a fixed-height list gave the runs a few rows to live in however
/// much space the pane had. Picked from [run-rows.html](../../demo/run-rows.html).
///
/// Newest first within each section, ordered by [buildTranscript](@/lib/transcript).
export default function SubagentPanel({ runs, ...rest }: SubagentPanelProps) {
  const sections = [
    { title: "Subagents", runs: runs.filter((run) => !isShellRun(run)) },
    { title: "Background tasks", runs: runs.filter((run) => isShellRun(run)) },
  ];
  return (
    <div className="flex shrink-0 flex-col">
      {sections.map(
        (section) =>
          section.runs.length > 0 && (
            <RunSection key={section.title} title={section.title} runs={section.runs} {...rest} />
          ),
      )}
    </div>
  );
}

export function RunSection({
  title,
  runs,
  count,
  selectedId,
  resultByCallId,
  live,
  onSelect,
  onOpen,
  onStopTask,
}: Omit<SubagentPanelProps, "runs"> & {
  title: string;
  runs: SubagentRun[];
  /// The heading's number where it is not every row: a bot's shells keep a
  /// finished one listed while it is open.
  count?: number;
}) {
  const n = count ?? runs.length;
  return (
    <div>
      <RunHeading
        title={title}
        count={n > 1 ? n : undefined}
        stoppable={runs.filter((run) => live && !run.done && run.taskId !== null)}
        onStopTask={onStopTask}
      />
      <div className="flex flex-col gap-0.5 px-1 pb-2">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            open={run.id === selectedId}
            resultByCallId={resultByCallId}
            live={live}
            onToggle={() => onSelect(run.id === selectedId ? null : run.id)}
            onOpen={onOpen && opensTab(run) ? () => onOpen(run) : undefined}
            locked={opensTab(run) && !canOpenTab(run)}
            onStopTask={onStopTask}
          />
        ))}
      </div>
    </div>
  );
}

/// A run section's title row: label, count and, where finished runs fold
/// under it, the chevron, all together on the left so the number reads as the
/// label's. Callers leave the count out at one, where the single row says it.
///
/// Stop all sits at the far end, over the rows' own stop buttons, and only
/// above two or more: with one, the row's own button is the whole job. A pile
/// of forgotten polling loops (DRA-264) is the case it exists for.
export function RunHeading({
  title,
  count,
  fold,
  stoppable,
  onStopTask,
}: {
  title: string;
  count?: string | number;
  /// The whole row toggles the folded runs; Stop all keeps its own click.
  fold?: { open: boolean; onToggle: () => void; label: string };
  /// Same reading as each row's own button, so the heading and rows agree.
  stoppable: SubagentRun[];
  onStopTask: (taskId: string) => void;
}) {
  return (
    <div
      onClick={fold?.onToggle}
      className={cn(
        "flex items-center px-3 pt-4 pb-2 text-ui text-muted-foreground",
        fold && "group/heading",
      )}
    >
      <span className={cn("flex items-center gap-1.5", fold && "transition-colors group-hover/heading:text-foreground")}>
        <span>{title}</span>
        {count !== undefined && <span className="tabular-nums">{count}</span>}
        {fold && (
          <button
            type="button"
            aria-expanded={fold.open}
            aria-label={`${fold.open ? "Hide" : "Show"} ${fold.label}`}
            className="flex shrink-0 cursor-default items-center"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 transition", fold.open && "rotate-90")} />
          </button>
        )}
      </span>
      {stoppable.length > 1 && (
        <Button
          variant="ghost"
          size="xs"
          // Pulled out by its own padding, so the words end on the rows' edge.
          className="-my-1 -mr-2 ml-auto shrink-0 text-ui text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            stoppable.forEach((run) => onStopTask(run.taskId!));
          }}
        >
          Stop all
        </Button>
      )}
    </div>
  );
}

/// Whether the spawning call is worth a row of its own.
///
/// The row exists to show the brief the agent was given. Claude's `Task`
/// carries one; Codex's spawn carries the agent's name and nothing else, so
/// drawing it printed `spawn_agent read_footer` directly under a header
/// already reading `Read footer` — the same fact twice, in the one slot the
/// reader opened the run to read.
///
/// Read off the call rather than off the harness: a spawn is worth drawing
/// when it briefs the agent, whoever sent it.
function hasBrief(spawn: AgentEvent): boolean {
  if (spawn.payload.type !== "tool_call_started") return false;
  const prompt = (spawn.payload.input as Record<string, unknown> | null)?.prompt;
  if (typeof prompt === "string" && prompt.trim().length > 0) return true;
  // fx nests its brief a level down, and for an fx run this call is the whole
  // account there is — without it every delegated run here opens onto nothing.
  return subagentBrief(spawn.payload.input) !== null;
}

/// The command a backgrounded `Bash` or `Monitor` was started with.
function spawnCommand(run: SubagentRun): string | null {
  if (run.spawn?.payload.type !== "tool_call_started") return null;
  const command = (run.spawn.payload.input as Record<string, unknown> | null)?.command;
  return typeof command === "string" && command.trim().length > 0 ? command : null;
}

/// The row's mark, bare in a fixed slot: the terminal glyph, the working orb
/// the chat's subagent row carries, or a check once a subagent is done. No
/// tile, which read as a control; the slot keeps every title on one line.
///
/// The slot is a bot task row's face, 20px wide, so a bot's Tasks tab draws
/// tasks and runs on one icon column and one title column.
function RunMark({ run, shell }: { run: SubagentRun; shell: boolean }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {shell ? (
        <SquareTerminal aria-label="Shell" className="size-4 text-muted-foreground" />
      ) : run.done ? (
        <Check aria-label="Done" className="size-3.5 text-muted-foreground" />
      ) : (
        <Orb state="working" variant="gyro" size={20} label="Working" />
      )}
    </span>
  );
}

/// One run. A subagent opens its conversation as a tab; a shell expands in
/// place onto the command it runs.
///
/// No tool name, token count or agent type: the harness's words for the
/// mechanism ("Task", "local_bash", "general-purpose") rather than for the work.
export function RunRow({
  run,
  open,
  resultByCallId,
  live,
  onToggle,
  onOpen,
  locked,
  onStopTask,
  at,
}: {
  run: SubagentRun;
  open: boolean;
  resultByCallId: Map<string, ToolResult>;
  live: boolean;
  onToggle: () => void;
  /// Where set, a click opens the run's tab rather than expanding the row.
  onOpen?: () => void;
  /// The tab has nothing to show until the run ends, so the row waits.
  locked: boolean;
  onStopTask: (taskId: string) => void;
  /// When a finished run ended, drawn at the row's end. Hover swaps it for
  /// the arrow, so the time sits flush right at rest.
  at?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Opening a run from the chat scrolls it into view — the panel keeps its own
  // scroll position across sessions and tabs, so the row a click just opened is
  // routinely off-screen. `nearest` leaves an already-visible row where it is.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const shell = isShellRun(run);
  const running = !run.done;
  const title = run.description ?? run.label ?? (shell ? "Background task" : "Subagent");
  // A subagent's current step, under its title. A shell's command waits
  // behind a click instead: it is long, and the title already says what it is.
  const step = !shell && running ? run.status : null;
  const command = shell ? spawnCommand(run) : null;

  // Only a run the harness still holds can be stopped. `taskId` is null until a
  // lifecycle event names it, and a dead child's tasks died with it — either way
  // the button would be one the CLI answers success to and nothing happens.
  const stoppable = live && !run.done && run.taskId !== null;
  // fx publishes no handle for a child, so its rows never carry Stop.
  const bare = !shell && run.spawn?.harness === "fx";

  // The brief a harness nests rather than streams — fx's, and the whole of what
  // it says about the child. Null everywhere else, where the spawning call's own
  // row is what carries the prompt.
  const brief =
    run.spawn?.payload.type === "tool_call_started"
      ? (subagentBrief(run.spawn.payload.input)?.task ?? null)
      : null;

  // A run whose spawn carries no brief and which has filed no events of its own
  // expands onto an empty box. Events arrive as it works, so this flips back on
  // by itself.
  const hasContent =
    command !== null || run.events.length > 0 || (run.spawn != null && hasBrief(run.spawn));
  const expands = !onOpen && !locked && hasContent;
  const opens = !!onOpen && !locked;

  return (
    <div
      ref={ref}
      className={cn(
        "group rounded-lg transition-colors",
        (opens || expands) && "hover:bg-sidebar-accent/50",
      )}
    >
      {/* A row, not one button: the stop control is a second action on the same
          line, and nesting it inside would be a button inside a button. */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={opens ? onOpen : onToggle}
          disabled={!opens && !expands}
          className={cn(
            "flex min-w-0 flex-1 cursor-default items-center gap-2 pl-2 text-left",
            // A finished subagent is history: the shorter row is half of how it
            // steps back, the bare check the other. A bare row is one height
            // throughout, so nothing jumps when its run ends.
            bare || (!shell && run.done) ? "py-1" : "py-1.5",
            stoppable ? "pr-1" : "pr-2.5",
          )}
        >
          <RunMark run={run} shell={shell} />
          <span className="min-w-0 flex-1">
            {/* Flex parents, because `shimmer-text` is inline-block: in a line
                box it sits on the baseline and lifts the text off centre. */}
            <span className="flex min-w-0 text-ui">
              <span
                className={cn(
                  "block max-w-full truncate",
                  !running
                    ? "text-muted-foreground"
                    : shell
                      ? "shimmer-text"
                      : "text-sidebar-foreground",
                )}
              >
                {title}
              </span>
            </span>
            {step && (
              <span className="flex min-w-0 text-xs">
                <span className="shimmer-text block max-w-full truncate">{step}</span>
              </span>
            )}
          </span>
          {/* Each kind says what a click does, on hover: a subagent opens a
              tab, a shell expands — and an open shell keeps its caret. */}
          {at && (
            <span className={cn("shrink-0 text-xs text-muted-foreground tabular-nums", opens && "group-hover:hidden")}>
              {relativeTime(at)}
            </span>
          )}
          {opens ? (
            <ArrowUpRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground",
                at ? "hidden group-hover:block" : "opacity-0 transition-opacity group-hover:opacity-100",
              )}
            />
          ) : (
            expands && (
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition",
                  open ? "rotate-90" : "opacity-0 group-hover:opacity-100",
                )}
              />
            )
          )}
        </button>

        {/* Shown rather than revealed on hover: a task running longer than it
            should is what sends the reader here. No tooltip — the square says
            stop, and `aria-label` says it to a screen reader. */}
        {stoppable && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={shell ? "Stop this task" : "Stop this subagent"}
            className="mr-1.5 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onStopTask(run.taskId!)}
          >
            <Square className="fill-current" />
          </Button>
        )}
      </div>

      {open && expands && (
        // Indented to the title, past the mark's tile and its gap.
        <div className="flex flex-col gap-2 pr-2.5 pb-2 pl-9">
          {command ? (
            <div className="rounded-md bg-muted/70 px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap text-sidebar-foreground">
              <span className="text-muted-foreground">$ </span>
              {command}
            </div>
          ) : brief ? (
            // A run whose whole account is the brief it was given draws that
            // brief as text, not as the spawning call's row with a caret of its
            // own to open inside the row the reader just opened.
            <p className="text-ui whitespace-pre-wrap text-sidebar-foreground">{brief}</p>
          ) : (
            run.spawn &&
            hasBrief(run.spawn) && (
              <EventRow event={run.spawn} resultByCallId={resultByCallId} openTool />
            )
          )}

          {!command &&
            run.events.map((event) => (
              <EventRow key={event.id} event={event} resultByCallId={resultByCallId} />
            ))}
        </div>
      )}
    </div>
  );
}
