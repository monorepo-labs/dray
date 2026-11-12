import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import TasksPanel from "@/components/TasksPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { CrewRow } from "@/lib/crew";
import type { PrMark, SessionIndexItem } from "@/types/events";
import "../App.css";

/// A bot's Tasks tab on made-up tasks, one per state its rows can be in:
/// a pull request ready to merge, one still running checks, one in conflict,
/// a draft, a merged one, a task waiting on the reader, one working, one
/// pinned and one set aside. Merge waits a second and resolves, so its busy
/// and done states can be watched; the real one is `merge_pr`.
const task = (id: string, title: string, flags: Partial<SessionIndexItem> = {}): SessionIndexItem =>
  ({
    sessionId: `01a1d000-0000-7000-8000-00000000000${id}`,
    title,
    cwd: "/repo",
    projectPath: "/repo",
    archived: false,
    pinned: false,
    aside: false,
    worktreeName: `task-${id}`,
    branch: `worktree-task-${id}`,
    ...flags,
  }) as unknown as SessionIndexItem;

const pr = (number: number, more: Partial<PrMark>): PrMark => ({
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

const ROWS: { row: CrewRow; pr?: PrMark }[] = [
  { row: { item: task("1", "Fix the pricing page copy", { pinned: true }), busy: false, asking: false, unread: false }, pr: pr(912, {}) },
  { row: { item: task("2", "Ask which launch date to use"), busy: false, asking: true, unread: false } },
  { row: { item: task("3", "Audit the landing page"), busy: true, asking: false, unread: false } },
  { row: { item: task("4", "Ship the changelog page"), busy: false, asking: false, unread: true }, pr: pr(915, {}) },
  { row: { item: task("5", "Add dark mode to docs"), busy: false, asking: false, unread: false }, pr: pr(916, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }) },
  { row: { item: task("6", "Rename the CLI flags"), busy: false, asking: false, unread: false }, pr: pr(917, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) },
  { row: { item: task("7", "Draft the onboarding email"), busy: false, asking: false, unread: false }, pr: pr(918, { isDraft: true, mergeStateStatus: "DRAFT" }) },
  { row: { item: task("a", "Fix the flaky login test"), busy: false, asking: false, unread: false }, pr: pr(919, { checksState: "FAILING", mergeStateStatus: "UNSTABLE" }) },
  { row: { item: task("b", "Tighten the footer spacing"), busy: false, asking: false, unread: false }, pr: pr(920, { mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" }) },
  { row: { item: task("c", "Add a pricing FAQ"), busy: false, asking: false, unread: false }, pr: pr(921, { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }) },
  { row: { item: task("8", "Bump the Shiki version"), busy: false, asking: false, unread: false }, pr: pr(901, { state: "MERGED", mergeable: null, mergeStateStatus: null }) },
  { row: { item: task("9", "Try a new sidebar font", { aside: true }), busy: false, asking: false, unread: false } },
];

function Demo() {
  const [rows, setRows] = useState(ROWS);
  const prs = new Map(rows.map((r) => [r.row.item.sessionId, r.pr]));
  const update = (sessionId: string, change: (r: (typeof ROWS)[number]) => (typeof ROWS)[number] | null) =>
    setRows((all) => all.flatMap((r) => (r.row.item.sessionId === sessionId ? (change(r) ?? []) : [r])));
  const setFlags = async (sessionId: string, flags: { archived?: boolean; pinned?: boolean; aside?: boolean }) =>
    update(sessionId, (r) =>
      flags.archived ? null : { ...r, row: { ...r.row, item: { ...r.row.item, ...flags } as SessionIndexItem } },
    );

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10">
        <h1 className="text-lg font-medium">Bot Tasks tab</h1>
        <p className="max-w-xl text-ui text-muted-foreground">
          #912 and #915 are ready, so they draw Merge; every other PR says its state. Merge here waits a second and
          then settles the task, as the app does once the merge lands. Hover a row for ⋯ and Settle; right-click for
          the menu.
        </p>
        {/* The side panel's width at its default. */}
        <div className="flex flex-col rounded-xl border border-border bg-card" style={{ width: 420, height: 480 }}>
          <TasksPanel
            rows={rows.map((r) => r.row)}
            prOf={(row) => prs.get(row.item.sessionId)}
            onOpen={() => {}}
            onSetFlags={setFlags}
            onFork={async () => {}}
            onDelete={async (id) => update(id, () => null)}
            onDetach={async (id) => update(id, () => null)}
            onMerge={async (row) => {
              await new Promise((done) => setTimeout(done, 1000));
              update(row.item.sessionId, () => null);
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
