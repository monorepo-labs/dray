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
/// `stalledTasks` on made-up tasks with realistic last messages: a PR ready to
/// merge, one failing checks, one in conflict, two idle tasks with a question,
/// and three it must leave out — working, checks running, and idle only ten
/// minutes. Each row first shows its last message cut to one line, as it does
/// while `task_need` runs or where it failed; **Write needs** lands the lines
/// Haiku wrote for these messages through the real prompt (there is no server
/// behind this page). Dismiss is stored for real; Reset clears it.
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
  reviewDecision: null,
  ...more,
});

const ROWS: { row: CrewRow; pr?: PrMark; said: string; need?: string }[] = [
  {
    row: row("1", "Add a rename button to the session header", 50),
    said: "I added the rename button to the session header and wired it to the same `rename_session` command the sidebar's menu uses, so both stay in sync. While testing I noticed the header is already crowded at the narrowest window width: with the branch chip and the stop button, the title truncates to about twelve characters, and the new button makes it eight. Two ways forward: keep the button and hide the branch chip below 900px, or drop the button and rely on double-clicking the title, which already works. Which do you prefer? I have not committed either.",
    need: "Pick: keep the button or drop it",
  },
  {
    row: row("2", "Move the session index to SQLite", 125),
    said: "Here is the migration plan before I touch anything. 1. Add `rusqlite` behind the existing `store` API so no caller changes. 2. On first start, read `index.json`, write every entry into a new `sessions.db`, and keep the JSON as a backup for one release. 3. Switch reads to SQLite, keep writing both for that release, then drop the JSON writer. Risks: two servers on one home would now contend on a database lock instead of a file rename, and an older build reading the home would see a stale index. The plan is in `docs/sqlite-plan.md`. Should I go ahead with this plan as written?",
    need: "Approve the SQLite migration plan as written",
  },
  {
    row: row("3", "Fix the pricing page copy", 40),
    pr: pr(908),
    said: "Opened **#908** with the new copy on the pricing page: the three tier names, the annual discount line and the footnote about seats all match the brief now. Checks pass and it is ready to merge. I left the FAQ alone since it was out of scope.",
  },
  {
    row: row("6", "Bump the Shiki version", 75),
    pr: pr(919, { checksState: "FAILING", mergeStateStatus: "BLOCKED" }),
    said: "The bump to Shiki 3 broke two snapshot tests in `code-render`: the new grammar splits template literals into more tokens, so the colours are right but the spans differ. I can update the snapshots, which is what upstream recommends, or pin Shiki 2 until the diff renderer is moved over. Which do you want?",
    need: "Pick: update snapshots or pin Shiki 2",
  },
  {
    row: row("7", "Rename the CLI flags", 50 * 60),
    pr: pr(917, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
    said: "#917 conflicts with main after the flags refactor landed in #912: both changed `parse_args` and the help text. Resolving it means rebasing onto main, which rewrites the branch you reviewed yesterday. Should I rebase and force-push, or open a fresh PR from main instead?",
    need: "Pick: rebase-and-force-push #917, or open fresh PR",
  },
  { row: row("8", "Audit the landing page", 90, true), said: "" },
  { row: row("4", "Add dark mode to docs", 60), pr: pr(916, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }), said: "" },
  { row: row("5", "Draft the onboarding email", 10), said: "" },
];

function Demo() {
  const [rows, setRows] = useState(ROWS);
  const [shown, setShown] = useState(0);
  const [needs, setNeeds] = useState<Record<string, string>>({});
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
          Eight tasks, five stalled. Each row shows its last message until the cheap model writes what the task needs.
          A row opens its task; Merge waits a second and takes it away, as settling does.
        </p>
        <div className="flex items-center gap-4 text-ui">
          <button
            type="button"
            className="underline"
            onClick={() => setNeeds(Object.fromEntries(ROWS.flatMap((r) => (r.need ? [[r.row.item.sessionId, r.need]] : []))))}
          >
            Write needs
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              localStorage.removeItem("ade.dismissedStalls");
              setRows(ROWS);
              setNeeds({});
              setShown((n) => n + 1);
            }}
          >
            Reset
          </button>
        </div>
        {/* The chat column's width and gap. */}
        <div className="flex max-w-3xl flex-col gap-4 rounded-xl border border-border px-6 py-6" data-bot-chat>
          <div className="max-w-[85%] self-start rounded-xl bg-muted/50 px-3 py-2 text-chat">
            On it. I started five tasks for that.
          </div>
          <StalledTasks
            key={shown}
            stalls={stalls}
            previews={previews}
            needs={needs}
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
