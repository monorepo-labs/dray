import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { devRuns, DEV_RUN_STATES, type DevRunState } from "@/components/botRunsDev";
import { RunRow, RunSection } from "@/components/SubagentPanel";
import { Button } from "@/components/ui/button";
import { canOpenTab, isShellRun, opensTab, type SubagentRun } from "@/lib/transcript";
import { invoke } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { SubagentList, SubagentSummary, ToolResult } from "@/types/events";

const PAGE = 20;

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

type Loader = (skip: number) => Promise<SubagentList>;

/// A bot's subagents and background shells, under its task list. Running
/// subagents show; finished ones wait behind a toggle and page in off the
/// server's logs, since the chat holds only its tail.
export default function BotRuns(props: Props) {
  const [dev, setDev] = useState<DevRunState>("live");
  const fake = import.meta.env.DEV && dev !== "live" ? devRuns(dev) : null;
  const { sessionId, also } = props;
  const load: Loader =
    fake?.load ?? ((skip) => invoke<SubagentList>("list_subagents", { sessionId, also, skip, limit: PAGE }));
  return (
    <>
      <Sections
        key={`${sessionId} ${dev}`}
        {...props}
        {...(fake && { runs: fake.runs, live: true, onOpen: () => {}, onStopTask: () => {} })}
        load={load}
      />
      {import.meta.env.DEV && <DevPicker value={dev} onChange={setDev} />}
    </>
  );
}

function Sections({ runs, load, ...rest }: Props & { load: Loader }) {
  const [open, setOpen] = useState(false);
  const [older, setOlder] = useState<SubagentList | null>(null);
  // The server offset of the next page. Not the count held: runs landing
  // between pages shift the list, and a page of nothing but repeats would
  // otherwise ask for itself again.
  const [next, setNext] = useState(PAGE);
  const [loading, setLoading] = useState(false);

  // Once per chat, for the count; an older server answering `unknown command`
  // leaves the loaded runs alone.
  useEffect(() => {
    load(0).then(setOlder, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const more = async () => {
    if (!older || loading) return;
    setLoading(true);
    try {
      const page = await load(next);
      setNext(next + PAGE);
      // A run landing since the last page shifts the server's list down by one.
      const had = new Set(older.runs.map((r) => r.id));
      setOlder({ ...page, runs: [...older.runs, ...page.runs.filter((r) => !had.has(r.id))] });
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
  const count = Math.max(completed.length, (older?.total ?? 0) - running.length);
  const shells = runs.filter((run) => isShellRun(run) && (!run.done || run.id === rest.selectedId));

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
        <>
          <RunSection title="Subagents" {...rest} runs={running.filter((run) => held.has(run.id))} />
          {/* Running but older than the loaded chat: no events here to open. */}
          {running.some((run) => !held.has(run.id)) && (
            <div className="-mt-2 flex flex-col gap-0.5 px-1.5 pb-2">
              {running.filter((run) => !held.has(run.id)).map((run) => row(run))}
            </div>
          )}
          {count > 0 && (
            <div className="-mt-2 flex flex-col gap-0.5 px-1.5 pb-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex cursor-default items-center gap-1.5 rounded-lg px-2.5 py-1 text-ui text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
              >
                <ChevronRight className={cn("size-3.5 transition", open && "rotate-90")} />
                {count} completed
              </button>
              {open && completed.map((run) => row(run, run.lastAt))}
              {open && older?.more && (
                <Button variant="ghost" size="xs" className="mx-1 self-start text-muted-foreground" disabled={loading} onClick={() => void more()}>
                  {loading ? "Loading…" : "Load more"}
                </Button>
              )}
            </div>
          )}
        </>
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

/// Dev builds only: puts the sections in each state over fake runs.
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
