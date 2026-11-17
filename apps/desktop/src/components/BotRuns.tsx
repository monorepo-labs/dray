import { Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { RunHeading, RunRow, RunSection } from "@/components/SubagentPanel";
import Spinner from "@/components/ui/spinner";
import { canOpenTab, isShellRun, opensTab, type SubagentRun } from "@/lib/transcript";
import { invoke } from "@/lib/transport";
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

  // Once per chat, for the count. A failure is retried with backoff, since a
  // drop or a server restart would otherwise leave the history missing until
  // the chat is reopened; an older server answering `unknown command` gives up
  // after the last try and leaves the loaded runs alone.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const attempt = (n: number) =>
      load(null, unseen(rest.liveTaskIds, runs, [])).then(
        (page) => !gone && setOlder(page),
        () => {
          if (!gone && n < 5) timer = setTimeout(() => attempt(n + 1), 1000 * 2 ** n);
        },
      );
    void attempt(0);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
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
          {/* The count is the finished runs folded under the chevron; running
              ones stay out under it either way. */}
          <RunHeading
            title="Subagents"
            count={count > 0 ? countLabel : undefined}
            fold={count > 0 ? { open, onToggle: () => setOpen(!open), label: "completed subagents" } : undefined}
            stoppable={stoppable}
            onStopTask={rest.onStopTask}
          />
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
      {shells.length > 0 && (
        <RunSection title="Background tasks" {...rest} runs={shells} count={shells.filter((run) => !run.done).length} />
      )}
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
