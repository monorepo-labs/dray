import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { RunRow, RunSection } from "@/components/SubagentPanel";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { canOpenTab, isShellRun, opensTab, type SubagentRun } from "@/lib/transcript";
import { invoke } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { SubagentCursor, SubagentList, SubagentSummary, ToolResult } from "@/types/events";

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

/// Finished runs per page: a page is read back from the log until it has these.
const PAGE = 10;

/// `live`: running tasks no run here accounts for, which the server reads back
/// until it has met.
type Loader = (cursor: SubagentCursor | null, live: string[]) => Promise<SubagentList>;

/// A bot's subagents and background shells, under its task list. Running
/// subagents show; finished ones wait behind a toggle and page in off the
/// server's logs, since the chat holds only its tail.
export default function BotRuns(props: Props) {
  const { sessionId, also } = props;
  const load: Loader = (cursor, live) =>
    invoke<SubagentList>("list_subagents", { sessionId, also, cursor, limit: PAGE, live });
  return <Sections key={sessionId} {...props} load={load} />;
}

function Sections({ runs, load, ...rest }: Props & { load: Loader }) {
  const [open, setOpen] = useState(false);
  const [older, setOlder] = useState<SubagentList | null>(null);
  const [loading, setLoading] = useState(false);

  // Once per chat, for the count; an older server answering `unknown command`
  // leaves the loaded runs alone.
  useEffect(() => {
    load(null, unseen(rest.liveTaskIds, runs, [])).then(setOlder, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const more = async () => {
    if (!older?.next || loading) return;
    setLoading(true);
    try {
      // The cursor is a byte offset, so runs landing since the first page
      // never shift what the next one reads.
      const page = await load(older.next, unseen(rest.liveTaskIds, runs, older.runs));
      // A running run found past a full page comes back again on the page
      // that reaches it.
      const had = new Set(older.runs.map((r) => r.id));
      setOlder({ next: page.next, runs: [...older.runs, ...page.runs.filter((r) => !had.has(r.id))] });
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
            <div className="flex flex-col gap-0.5 px-1 pb-2">
              {running.map((run) => row(run))}
              {open && completed.map((run) => row(run, run.lastAt))}
              {open && older?.next && (
                // A finished row's frame, so the chevron sits in the checks'
                // column and the label starts where their titles do.
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void more()}
                  className="flex cursor-default items-center gap-2 rounded-lg py-1 pr-2.5 pl-2 text-left text-ui text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:hover:bg-transparent"
                >
                  <span className="flex h-4 w-5 shrink-0 items-center justify-center">
                    {loading ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
                  </span>
                  {loading ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {shells.length > 0 && <RunSection title="Background tasks" {...rest} runs={shells} />}
    </div>
  );
}

/// Live tasks no loaded run and no listed run accounts for, by either id a
/// task goes by.
function unseen(live: ReadonlySet<string>, runs: SubagentRun[], listed: SubagentSummary[]): string[] {
  const known = new Set([...runs, ...listed].flatMap((r) => [r.id, r.taskId ?? ""]));
  return [...live].filter((id) => !known.has(id));
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
