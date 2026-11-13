import { ChatBubbleOvalLeftIcon } from "@heroicons/react/16/solid";
import { GitPullRequestArrow } from "lucide-react";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import BotAvatar from "@/components/BotAvatar";
import TasksPanel from "@/components/TasksPanel";
import { ItemTab, RowMachine } from "@/components/layout/ViewTabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { seededAvatar } from "@/lib/botAvatar";
import type { CrewRow } from "@/lib/crew";
import type { PrMark, SessionIndexItem } from "@/types/events";
import "../App.css";

/// A bot's task on another machine: a server glyph on its Tasks row and on
/// its tab, the name in the glyph's tooltip and at the titlebar's far end. A path under `dray://boat/` is how the
/// app keys a remote session, so `serverOfPath` names the machine `boat` here
/// with no stub. Local tasks carry no mark.
const BOAT = "dray://boat/repo";

const task = (id: string, title: string, path = "/repo"): SessionIndexItem =>
  ({
    sessionId: `01a1d000-0000-7000-8000-00000000000${id}`,
    title,
    cwd: path,
    projectPath: path,
    archived: false,
    pinned: false,
    aside: false,
  }) as unknown as SessionIndexItem;

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

const row = (item: SessionIndexItem, more: Partial<CrewRow> = {}): CrewRow => ({
  item,
  busy: false,
  asking: false,
  unread: false,
  background: false,
  ...more,
});

const AUTO_POST = task("1", "Auto-post merge card", BOAT);
const CUBICLE = task("2", "Set up a Cubicle box");

const ROWS: { row: CrewRow; pr?: PrMark }[] = [
  { row: row(AUTO_POST), pr: pr(954) },
  { row: row(task("3", "Audit the landing page", BOAT), { busy: true }) },
  { row: row(task("4", "Ask which launch date to use for the pricing page announcement", BOAT), { asking: true }) },
  { row: row(CUBICLE), pr: pr(955, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }) },
  { row: row(task("5", "Rename the CLI flags", BOAT)), pr: pr(917, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) },
  { row: row(task("6", "Bump the Shiki version")), pr: pr(901, { state: "MERGED", mergeable: null, mergeStateStatus: null }) },
];
const PRS = new Map(ROWS.map((r) => [r.row.item.sessionId, r.pr]));

const face = (item: SessionIndexItem) => (
  <BotAvatar seed={item.sessionId} avatar={seededAvatar(item.sessionId)} className="block size-4 shrink-0 scale-[1.18]" />
);

/// The bot's titlebar row with its remote task lit: the bot's chat, both task
/// tabs, and the far end as ViewTabs draws it — the machine, the worktree and
/// the PR. The far end is the existing mark for any
/// remote session.
function Header() {
  const [lit, setLit] = useState(AUTO_POST.sessionId);
  const remoteLit = lit === AUTO_POST.sessionId;
  return (
    <div className="flex h-10 w-full items-center gap-0.5 rounded-xl border border-border bg-surface-frame px-2">
      <ItemTab icon={<ChatBubbleOvalLeftIcon className="size-4 shrink-0 text-muted-foreground" />} label="Dray" active={lit === "chat"} onPick={() => setLit("chat")} fixed />
      {[AUTO_POST, CUBICLE].map((item) => (
        <ItemTab
          key={item.sessionId}
          icon={face(item)}
          label={item.title}
          active={lit === item.sessionId}
          onPick={() => setLit(item.sessionId)}
          onClose={() => {}}
          machine={item === AUTO_POST ? "boat" : undefined}
        />
      ))}
      {remoteLit && <RowMachine name="boat" />}
      <span className={`flex shrink-0 items-center gap-3 pl-3 text-ui text-muted-foreground ${remoteLit ? "" : "ml-auto"}`}>
        <span>noble-jade-quarry</span>
        <span className="flex items-center gap-1 text-foreground">
          <GitPullRequestArrow className="size-3.5 text-accent-add" />
          #954
        </span>
      </span>
    </div>
  );
}

function Demo() {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6 p-10">
        <div>
          <h1 className="text-lg font-medium">Which machine a bot's task runs on</h1>
          <p className="max-w-2xl text-ui text-muted-foreground">
            Four of the six tasks run on <b>boat</b>; Set up a Cubicle box and Bump the Shiki version run on this Mac and
            carry no mark. The header has the boat task lit — click the other tab to see the far end drop the name. Hover a glyph for its machine.
          </p>
        </div>
        <section className="flex w-[640px] flex-col gap-3">
          <Header />
          <div className="flex flex-col rounded-xl border border-border bg-card" style={{ width: 420, height: 252 }}>
            <TasksPanel
              rows={ROWS.map((r) => r.row)}
              prOf={(r) => PRS.get(r.item.sessionId)}
              onOpen={() => {}}
              onSetFlags={async () => {}}
              onFork={async () => {}}
              onDelete={async () => {}}
              onDetach={async () => {}}
              onFixConflicts={async () => {}}
              onMerge={async () => {}}
            />
          </div>
        </section>
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
