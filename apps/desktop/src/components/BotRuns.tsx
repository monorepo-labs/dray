import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { devRuns, DEV_RUN_STATES, setDevRunState, useDevRunState, type DevRunState } from "@/components/botRunsDev";
import { RunRow, RunSection } from "@/components/SubagentPanel";
import { Button } from "@/components/ui/button";
import { canOpenTab, isShellRun, opensTab, type SubagentRun } from "@/lib/transcript";
import { invoke } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { SubagentCursor, SubagentList, SubagentSummary, ToolResult } from "@/types/events";

/// Finished runs per page: a page is read back from the log until it has these.

type Props = {
  sessionId: string;
  /// The chat's earlier sessions, newest first, whose subagents list too.
  also: string[];
  /// Built from the loaded part of the chat, newest first, shells included.
  runs: SubagentRun[];
  selectedId: string | null;
  resultByCallId: Map<string, ToolResult>;
  live: boolean;
  /// Tasks the child still holds, by handle: a log-only run with no end is
  /// running only while its task is here.
  liveTaskIds: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onOpen?: (run: SubagentRun) => void;
  onStopTask: (taskId: string) => void;
};

const PAGE = 10;

type Loader = (cursor: SubagentCursor | null) => Promise<SubagentList>;

/// A bot's subagents and background shells, under its task list. Running
/// subagents show; finished ones wait behind a toggle and page in off the
/// server's logs, since the chat holds only its tail.
export default function BotRuns(props: Props) {
  const dev = useDevRunState();
  const fake = import.meta.env.DEV && dev !== "live" ? devRuns(dev) : null;
  const { sessionId, also } = props;
  const load: Loader =
    fake?.load ?? ((cursor) => invoke<SubagentList>("list_subagents", { sessionId, also, cursor, limit: PAGE }));
  return (
    <>
      <Sections
        key={`${sessionId} ${dev}`}
        {...props}
        {...(fake && { runs: fake.runs, live: true, onOpen: () => {}, onStopTask: () => {} })}
        load={load}
      />
      {import.meta.env.DEV && <DevPicker value={dev} onChange={setDevRunState} />}
    </>
  );
}

function Sections({ runs, load, ...rest }: Props & { load: Loader }) {
  const [open, setOpen] = useState(false);
  const [older, setOlder] = useState<SubagentList | null>(null);
  const [loading, setLoading] = useState(false);

  // Once per chat, for the count; an older server answering `unknown command`
  // leaves the loaded runs alone.
  useEffect(() => {
    load(null).then(setOlder, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const more = async () => {
    if (!older?.next || loading) return;
    setLoading(true);
    try {
      // The cursor is a byte offset, so runs landing since the first page
      // never shift what the next one reads.
      const page = await load(older.next);
      setOlder({ next: page.next, runs: [...older.runs, ...page.runs] });
    } finally {
      setLoading(false);
    }
  };

  const held = new Set(runs.map((run) => run.id));
  const agents = [
    ...runs.filter((run) => !isShellRun(run)),
    ...(older?.runs ?? []).filter((s) => !held.has(s.id)).map((s) => fromLog(s, rest.liveTaskIds)),
  ];
  const running = agents.filter((run) => !run.done);
  const completed = agents.filter((run) => run.done);
  const count = completed.length;
  // Pages stop at ten finished runs, so a total is never known up front.
  const countLabel = older?.next ? `${count}+` : `${count}`;
  const shells = runs.filter((run) => isShellRun(run) && (!run.done || run.id === rest.selectedId));
  const stoppable = running.filter((run) => rest.live && run.taskId !== null);

  const row = (run: SubagentRun, at?: string) => (
    <RunRow
      key={run.id}
      run={run}
      at={at}
      open={run.id === rest.selectedId}
      resultByCallId={rest.resultByCallId}
      live={rest.live}
      onToggle={() => rest.onSelect(run.id === rest.selectedId ? null : run.id)}
      // A run read off the log alone has no events here to open onto.
      onOpen={rest.onOpen && held.has(run.id) && opensTab(run) ? () => rest.onOpen!(run) : undefined}
      locked={opensTab(run) && !canOpenTab(run)}
      onStopTask={rest.onStopTask}
    />
  );

  return (
    <div className="flex shrink-0 flex-col">
      {(running.length > 0 || count > 0) && (
        <div className="flex flex-col">
          {/* The whole heading folds the finished runs; running ones stay out
              under it either way. Stop all sits between the title and the
              count, so the row takes the click and Stop all keeps its own. */}
          <div
            onClick={() => count > 0 && setOpen(!open)}
            className={cn(
              "group/heading flex items-center gap-1.5 px-3 pt-4 pb-2 text-ui text-muted-foreground",
              count > 0 && "transition-colors hover:text-foreground",
            )}
          >
            <span className="flex-1">Subagents</span>
            {stoppable.length > 1 && (
              <Button
                variant="ghost"
                size="xs"
                className="-my-1 shrink-0 text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  stoppable.forEach((run) => rest.onStopTask(run.taskId!));
                }}
              >
                Stop all
              </Button>
            )}
            {count > 0 && (
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} completed subagents`}
                className="flex shrink-0 cursor-default items-center gap-1.5"
              >
                <span className="tabular-nums">{countLabel}</span>
                <ChevronRight className={cn("size-3.5 shrink-0 transition", open && "rotate-90")} />
              </button>
            )}
          </div>
          {(running.length > 0 || open) && (
            <div className="flex flex-col gap-0.5 px-1.5 pb-2">
              {running.map((run) => row(run))}
              {open && completed.map((run) => row(run, run.lastAt))}
              {open && older?.next && (
                <Button variant="ghost" size="xs" className="mx-1 self-start text-muted-foreground" disabled={loading} onClick={() => void more()}>
                  {loading ? "Loading…" : "Load more"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {shells.length > 0 && <RunSection title="Background tasks" {...rest} runs={shells} />}
    </div>
  );
}

/// A run the chat has not loaded, drawn as a row of its own. One the log never
/// closed is still going only while its child holds the task; otherwise it died
/// with its child.
function fromLog(s: SubagentSummary, live: ReadonlySet<string>): SubagentRun {
  const done = s.endedAt !== null || !live.has(s.taskId ?? s.id);
  return {
    id: s.id,
    taskId: s.taskId,
    label: s.label,
    description: s.description,
    status: null,
    lastTool: null,
    done,
    background: false,
    usage: null,
    events: [],
    inline: false,
    opensWhenDone: false,
    spawn: null,
    lastAt: s.endedAt ?? s.startedAt,
  };
}

/// Dev builds only: puts the tasks and runs in each state over fake data.
function DevPicker({ value, onChange }: { value: DevRunState; onChange: (v: DevRunState) => void }) {
  return (
    <div className="mx-3 mt-4 mb-3 flex flex-wrap items-center gap-1 rounded-md border border-dashed border-border p-1.5 text-xs text-muted-foreground">
      <span className="px-1">Dev state</span>
      {(Object.keys(DEV_RUN_STATES) as DevRunState[]).map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "rounded px-1.5 py-0.5 transition-colors",
            value === id ? "bg-muted text-foreground" : "hover:text-foreground",
          )}
        >
          {DEV_RUN_STATES[id]}
        </button>
      ))}
    </div>
  );
}
