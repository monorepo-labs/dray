import React, { useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import StalledTasks from "@/components/chat/StalledTasks";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { CrewRow } from "@/lib/crew";
import { stalledTasks } from "@/lib/stalled";
import type { BotPreview, PrMark, SessionIndexItem } from "@/types/events";
import "../App.css";

/// The stalled-tasks card at the foot of a bot's chat, run through the real
/// `stalledTasks` on made-up tasks: a PR ready to merge, one failing checks,
/// one in conflict, a task idle with no PR, and three it must leave out —
/// working, checks running, and idle only ten minutes. One line or two of each
/// task's last message, toggled. Dismiss is stored for real; Reset clears it.
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
  background: false,
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

const ROWS: { row: CrewRow; pr?: PrMark; said: string }[] = [
  {
    row: row("1", "Fix the pricing page copy", 40),
    pr: pr(908),
    said: "Opened **#908** with the new copy on the pricing page. Checks pass and it is ready to merge; I left the FAQ alone since it was out of scope.",
  },
  {
    row: row("2", "Ask which launch date to use", 125),
    said: "Two dates in the brief disagree: the deck says March 3, the doc says March 10. Which one should the countdown use?",
  },
  {
    row: row("6", "Bump the Shiki version", 75),
    pr: pr(919, { checksState: "FAILING", mergeStateStatus: "BLOCKED" }),
    said: "The bump to Shiki 3 broke two snapshot tests in `code-render`. Want me to update the snapshots, or pin the old version?",
  },
  {
    row: row("7", "Rename the CLI flags", 50 * 60),
    pr: pr(917, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
    said: "#917 conflicts with main after the flags refactor landed. I can rebase it if you want, but it rewrites the branch.",
  },
  { row: row("3", "Audit the landing page", 90, true), said: "" },
  { row: row("4", "Add dark mode to docs", 60), pr: pr(916, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }), said: "" },
  { row: row("5", "Draft the onboarding email", 10), said: "" },
];

function Demo() {
  const [rows, setRows] = useState(ROWS);
  const [lines, setLines] = useState<1 | 2>(1);
  const [shown, setShown] = useState(0);
  const readySince = useRef(new Map<string, number>());
  const prs = new Map(rows.map((r) => [r.row.item.sessionId, r.pr]));
  const previews: Record<string, BotPreview> = Object.fromEntries(
    rows.map((r) => [r.row.item.sessionId, { text: r.said, replies: 1 }]),
  );
  const stalls = stalledTasks(rows.map((r) => r.row), (r) => prs.get(r.item.sessionId), readySince.current, NOW);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10">
        <h1 className="text-lg font-medium">Stalled tasks in a bot's chat</h1>
        <p className="max-w-xl text-ui text-muted-foreground">
          Seven tasks, four stalled. A row opens its task; Merge waits a second and takes it away, as settling does.
          Dismiss hides these stalls until the task changes.
        </p>
        <div className="flex items-center gap-4 text-ui">
          {([1, 2] as const).map((n) => (
            <label key={n} className="flex items-center gap-1.5">
              <input type="radio" checked={lines === n} onChange={() => setLines(n)} />
              {n === 1 ? "One line" : "Two lines"}
            </label>
          ))}
          <button
            type="button"
            className="underline"
            onClick={() => {
              localStorage.removeItem("ade.dismissedStalls");
              setRows(ROWS);
              setShown((n) => n + 1);
            }}
          >
            Reset
          </button>
        </div>
        {/* The chat column's width and gap. */}
        <div className="flex max-w-3xl flex-col gap-4 rounded-xl border border-border px-6 py-6" data-bot-chat>
          <div className="max-w-[85%] self-start rounded-xl bg-muted/50 px-3 py-2 text-chat">
            On it. I started four tasks for that.
          </div>
          <StalledTasks
            key={shown}
            stalls={stalls}
            previews={previews}
            now={NOW}
            lines={lines}
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
