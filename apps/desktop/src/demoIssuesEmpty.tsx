import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import IssuesView from "@/components/IssuesView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Connected } from "@/lib/issueTracker";
import type { Issue, IssueFilters } from "@/types/events";
import "./App.css";

/// The repository the GitHub half reads, which the page takes from the reader's
/// own stored pick rather than from a prop. Seeded here, or that case draws the
/// "pick a repository" state instead of the one being looked at.
///
/// **Only where there is nothing there.** The dev app is served from this same
/// origin, so this is the reader's own local storage — a demo page must not
/// write over a pick they made in the app itself.
if (localStorage.getItem("ade.issueRepo") === null) {
  localStorage.setItem("ade.issueRepo", JSON.stringify("monorepo-labs/dray"));
}

const LINEAR_ROWS: Issue[] = [
  {
    tracker: "linear",
    id: "uuid-1",
    identifier: "DRA-173",
    title: "App shortcuts dead after the browser view hides with focus inside it",
    url: "https://linear.app/x/issue/DRA-173",
    state: { id: "s1", name: "In Progress", kind: "started", color: "#f2c94c" },
    priority: "medium",
    assignee: { name: "Yogesh Dhakal", avatar: null },
    author: { name: "Yogesh Dhakal", avatar: null },
    labels: [],
    team: "DRA",
    project: null,
    createdAt: "2026-09-05T10:30:02Z",
    updatedAt: "2026-09-09T05:51:58Z",
    pullRequests: [143, 144],
  },
  {
    tracker: "linear",
    id: "uuid-2",
    identifier: "DRA-80",
    title: "Codex as a second harness, over codex app-server",
    url: "https://linear.app/x/issue/DRA-80",
    state: { id: "s2", name: "Todo", kind: "unstarted", color: "#8a8f98" },
    priority: "high",
    assignee: { name: "Yogesh Dhakal", avatar: null },
    author: { name: "Yogesh Dhakal", avatar: null },
    labels: [],
    team: "DRA",
    project: "Integrations",
    createdAt: "2026-08-29T09:00:00Z",
    updatedAt: "2026-09-01T09:00:00Z",
    pullRequests: [54],
  },
];

const GITHUB_ROWS: Issue[] = [
  {
    tracker: "github",
    id: "gh-1",
    identifier: "monorepo-labs/dray#248",
    title: "Read GitHub issues beside Linear",
    url: "https://github.com/monorepo-labs/dray/issues/248",
    state: { id: "OPEN", name: "Open", kind: "unstarted", color: "#1a7f37" },
    priority: "none",
    assignee: null,
    author: { name: "yogesh", avatar: null },
    labels: [{ name: "feature", color: "#a2eeef" }],
    team: "monorepo-labs/dray",
    project: null,
    createdAt: "2026-09-22T05:32:40Z",
    updatedAt: "2026-09-22T05:32:40Z",
    pullRequests: [249],
  },
  {
    tracker: "github",
    id: "gh-2",
    identifier: "monorepo-labs/dray#108",
    title: "Sidebar rows reorder under the cursor while a turn is running",
    url: "https://github.com/monorepo-labs/dray/issues/108",
    state: { id: "OPEN", name: "Open", kind: "unstarted", color: "#1a7f37" },
    priority: "none",
    assignee: null,
    author: { name: "yogesh", avatar: null },
    labels: [{ name: "bug", color: "#d73a4a" }],
    team: "monorepo-labs/dray",
    project: null,
    createdAt: "2026-09-01T16:56:52Z",
    updatedAt: "2026-09-18T11:00:00Z",
    pullRequests: [],
  },
];

const FILTERS: IssueFilters = {
  teams: [{ id: "team-1", name: "Dray" }],
  projects: [{ id: "proj-1", name: "Integrations" }],
  labels: [
    { name: "bug", color: "#d73a4a" },
    { name: "feature", color: "#a2eeef" },
  ],
  teamStates: {},
};

/// `invoke` rejects outside Tauri, so every read this page makes and both of the
/// links on the connect pane have to be answered here. Stubbed *outside* the
/// component, so nothing in `src/` carries a demo seam.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "plugin:opener|open_url") {
      // eslint-disable-next-line no-console
      console.log("demo: would open", args.url);
      return null;
    }
    if (cmd === "list_issues") {
      const query = args.query as { tracker: string; settled: boolean };
      if (query.settled) return [];
      return query.tracker === "github" ? GITHUB_ROWS : LINEAR_ROWS;
    }
    if (cmd === "list_issue_filters") return FILTERS;
    if (cmd === "github_repo") return "monorepo-labs/dray";
    // The GitHub pane's own button. `false` is the answer worth seeing: it is
    // what a reader who has not actually installed or signed in gets, and the
    // pane staying put is the whole of what it says.
    if (cmd === "recheck_gh") return false;
    if (cmd === "get_integrations") return { linear: null, github: null };
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

/// What the issues page draws for each of the four ways the two trackers can be
/// connected — and what it says about the tracker that is *not*.
///
/// It exists to answer that, which cannot be seen on a machine with a Linear key
/// and a signed-in `gh`, which is every machine this is developed on. The PR
/// panel's own empty states are a separate page for the same reason. Delete this
/// once it has answered.
///
/// Worth knowing while looking at it: a **missing** `gh` and a **logged-out**
/// one are one state, `NotConnected`, so both draw whatever GitHub-absent draws.
const CASES: { id: string; title: string; note: string; connected: Connected }[] = [
  {
    id: "neither",
    title: "Neither",
    note: "Both panes reachable from the switch. Linear's key form; GitHub's two commands.",
    connected: { linear: false, github: false },
  },
  {
    id: "linear",
    title: "Linear only",
    note: "No gh, or gh logged out. The switch stays — press GitHub for its connect pane.",
    connected: { linear: true, github: false },
  },
  {
    id: "github",
    title: "GitHub only",
    note: "No Linear key. The same in reverse, and Linear's pane is one press away.",
    connected: { linear: false, github: true },
  },
  {
    id: "both",
    title: "Both",
    note: "Two real lists. The switch reads the same here as it does in the three above.",
    connected: { linear: true, github: true },
  },
];

function Demo() {
  const [picked, setPicked] = useState(CASES[0]);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  return (
    <TooltipProvider>
      {/* `bg-background` because this page brings no `AppShell`: the real
          window is translucent and its backdrop is what fills it, so without a
          fill here the surfaces composite against the browser's own white. */}
      <div className="flex h-full bg-background">
        <div className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border p-6">
          <h1 className="mb-2 text-lg font-medium">Issues page — what is connected</h1>

          {CASES.map((demo) => (
            <button
              key={demo.id}
              type="button"
              onClick={() => setPicked(demo)}
              className={cn(
                "cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors",
                picked.id === demo.id
                  ? "border-border bg-sidebar-accent"
                  : "border-border/60 hover:bg-sidebar-accent/50",
              )}
            >
              <span className="block text-ui font-medium">{demo.title}</span>
              <span className="block text-xs text-muted-foreground">{demo.note}</span>
            </button>
          ))}
        </div>

        {/* Keyed, so switching case remounts rather than leaving the previous
            tracker's rows under the new one's controls for a frame. */}
        <div key={picked.id} className="flex min-w-0 flex-1 flex-col">
          <IssuesView
            active
            connected={picked.connected}
            connecting={connecting}
            connectError={error}
            // Refusing is the half worth seeing: it is the only thing that
            // draws the red line under the form.
            onConnect={async () => {
              setConnecting(true);
              await new Promise((done) => setTimeout(done, 600));
              setConnecting(false);
              setError("Linear rejected that key.");
              return false;
            }}
            onRecheckGithub={async () => {
              setConnecting(true);
              await new Promise((done) => setTimeout(done, 600));
              setConnecting(false);
            }}
            picked={null}
            onPick={() => {}}
            onWorkOn={() => {}}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
