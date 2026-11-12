import React, { useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import StalledTasks from "@/components/chat/StalledTasks";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { CrewRow } from "@/lib/crew";
import { stalledTasks } from "@/lib/stalled";
import type { PrMark, SessionIndexItem } from "@/types/events";
import "../App.css";

/// The card at the foot of a bot's chat listing its stalled tasks, run through
/// the real `stalledTasks` on made-up tasks: a PR ready for 40 minutes, one
/// idle for two hours, and three it must leave out — working, checks running,
/// and idle only ten minutes. Dismiss is stored for real; Reset clears it.
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const row = (id: string, title: string, minutes: number, busy = false): CrewRow => ({
  item: {
    sessionId: `01a1d000-0000-7000-8000-00000000000${id}`,
    title,
    modified: ago(minutes),
    projectPath: "/repo",
    worktreeName: `task-${id}`,
  } as unknown as SessionIndexItem,
  busy,
  asking: false,
  unread: false,
});

const pr = (number: number, more: Partial<PrMark> = {}): PrMark => ({
  number,
  url: `https://github.com/acme/site/pull/${number}`,
  headRefName: "",
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  ...more,
});

const ROWS: { row: CrewRow; pr?: PrMark }[] = [
  { row: row("1", "Fix the pricing page copy", 40), pr: pr(908) },
  { row: row("2", "Ask which launch date to use", 125) },
  { row: row("3", "Audit the landing page", 90, true) },
  { row: row("4", "Add dark mode to docs", 60), pr: pr(916, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }) },
  { row: row("5", "Rename the CLI flags", 10) },
];

function Demo() {
  const [rows, setRows] = useState(ROWS);
  const [shown, setShown] = useState(0);
  const readySince = useRef(new Map<string, number>());
  const prs = new Map(rows.map((r) => [r.row.item.sessionId, r.pr]));
  const stalls = stalledTasks(rows.map((r) => r.row), (r) => prs.get(r.item.sessionId), readySince.current, NOW);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10">
        <h1 className="text-lg font-medium">Stalled tasks in a bot's chat</h1>
        <p className="max-w-xl text-ui text-muted-foreground">
          Five tasks, two stalled. Merge waits a second and takes the task away, as settling does. Dismiss hides these
          stalls until the task changes.
        </p>
        <button
          type="button"
          className="w-fit text-ui underline"
          onClick={() => {
            localStorage.removeItem("ade.dismissedStalls");
            setRows(ROWS);
            setShown((n) => n + 1);
          }}
        >
          Reset
        </button>
        {/* The chat column's width and gap. */}
        <div className="flex max-w-3xl flex-col gap-4 rounded-xl border border-border px-6 py-6" data-bot-chat>
          <div className="max-w-[85%] self-start rounded-xl bg-muted/50 px-3 py-2 text-chat">
            On it. I started two tasks for that.
          </div>
          <StalledTasks
            key={shown}
            stalls={stalls}
            now={NOW}
            onOpen={() => {}}
            onMerge={async (r) => {
              await new Promise((done) => setTimeout(done, 1000));
              setRows((all) => all.filter((x) => x.row.item.sessionId !== r.item.sessionId));
            }}
          />
        </div>
      </div>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
