import React, { useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import StalledTasks from "@/components/chat/StalledTasks";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { CrewRow } from "@/lib/crew";
import { compactAge, onCard, stalledTasks } from "@/lib/stalled";
import type { PrMark, SessionIndexItem } from "@/types/events";
import "../App.css";

/// The stalled-tasks card at the foot of a bot's chat, run through the real
/// `stalledTasks` and `onCard` on made-up tasks: a PR ready to merge, two idle
/// tasks with a question, a PR waiting on review, one idle task the bot answers
/// itself, two PRs the task can mend (failing checks, a conflict), and three
/// left out — working, checks running, and idle only ten minutes. The card
/// starts with the ready PR alone; the rest go to the bot, listed under the
/// chat as the nudges the app sends. **Bot writes needs** lands the lines a bot
/// would write with `dray session need`, which puts those tasks on the card.
/// There is no server behind this page. Dismiss is stored for real; Reset
/// clears it.
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

const ROWS: { row: CrewRow; pr?: PrMark; need?: string }[] = [
  { row: row("1", "Add a rename button to the session header", 50), need: "Pick: keep the button or drop it" },
  { row: row("2", "Move the session index to SQLite", 125), need: "Approve the SQLite migration plan as written" },
  { row: row("3", "Fix the pricing page copy", 40), pr: pr(908) },
  {
    row: row("9", "Tighten the docs search ranking", 95),
    pr: pr(921, { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }),
    need: "Review #921: it reorders search results",
  },
  // Idle on a question the bot can answer from what the reader already said.
  { row: row("0", "Write the release notes", 45) },
  { row: row("6", "Bump the Shiki version", 75), pr: pr(919, { checksState: "FAILING", mergeStateStatus: "UNSTABLE" }) },
  { row: row("7", "Rename the CLI flags", 50 * 60), pr: pr(917, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) },
  { row: row("8", "Audit the landing page", 90, true) },
  { row: row("4", "Add dark mode to docs", 60), pr: pr(916, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }) },
  { row: row("5", "Draft the onboarding email", 10) },
];

function Demo() {
  const [rows, setRows] = useState(ROWS);
  const [shown, setShown] = useState(0);
  const readySince = useRef(new Map<string, number>());
  const prs = new Map(rows.map((r) => [r.row.item.sessionId, r.pr]));
  const stalls = stalledTasks(rows.map((r) => r.row), (r) => prs.get(r.item.sessionId), readySince.current, NOW);
  const card = stalls.filter(onCard);
  const nudges = stalls.filter((s) => s.kind !== "ready" && !onCard(s));

  const writeNeeds = () =>
    setRows((all) =>
      all.map((r) =>
        r.need ? { ...r, row: { ...r.row, item: { ...r.row.item, need: { text: r.need, at: new Date().toISOString() } } } } : r,
      ),
    );

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10">
        <h1 className="text-lg font-medium">Stalled tasks in a bot's chat</h1>
        <p className="max-w-xl text-ui text-muted-foreground">
          Ten tasks, seven stalled. Only a ready PR and a need the bot wrote reach the card; the rest go to the bot. A
          row opens its task; Merge waits a second and takes it away, as settling does.
        </p>
        <div className="flex items-center gap-4 text-ui">
          <button type="button" className="underline" onClick={writeNeeds}>
            Bot writes needs
          </button>
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
            On it. I started five tasks for that.
          </div>
          <StalledTasks
            key={shown}
            stalls={card}
            now={NOW}
            onOpen={() => {}}
            onMerge={async (r) => {
              await new Promise((done) => setTimeout(done, 1000));
              setRows((all) => all.filter((x) => x.row.item.sessionId !== r.item.sessionId));
            }}
          />
        </div>
        <div className="flex max-w-3xl flex-col gap-1 text-ui">
          <span className="text-muted-foreground">Nudges sent to the bot, hidden from the reader</span>
          {nudges.map((s) => (
            <span key={s.key} className="font-mono text-[12px] text-foreground/80">
              {s.row.item.title}: Stall nudge: this task has sat {s.kind === "fix" ? "untouched" : "idle"} for{" "}
              {compactAge(s.row.item.modified, NOW)}. {s.problem ?? "Waiting on the user. Its last message: …"}
            </span>
          ))}
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
