import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import PrPanel from "@/components/PrPanel";
import RightPanel, { TabBody, tabOrder } from "@/components/RightPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ExternalApp, PrUnavailable } from "@/types/events";
import "../App.css";

/// The terminals this machine is pretending to have.
///
/// `invoke` rejects outside Tauri, so the real app scan answers nothing and
/// `OpenInButton` — which draws nothing rather than an empty menu — would take
/// the control being looked at off the page. Stubbing the bridge is the one
/// thing this page fakes, and it fakes it *outside* the components, so nothing
/// in `src/` carries a demo seam.
const TERMINALS: ExternalApp[] = [
  { path: "/Applications/Ghostty.app", name: "Ghostty", kind: "terminal", icon: null },
  {
    path: "/System/Applications/Utilities/Terminal.app",
    name: "Terminal",
    kind: "terminal",
    icon: null,
  },
];

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    if (cmd === "list_open_apps") return TERMINALS;
    // No, which is the answer worth seeing: it is what draws the line under
    // the buttons saying the CLI still is not there.
    if (cmd === "recheck_gh") return false;
    if (cmd === "open_in_app") return null;
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

const CWD = "/Users/you/code/dray";

/// What the PR pane draws when there is no pull request behind it.
///
/// It exists to answer one thing — what a reader who has never set `gh` up sees
/// now that the tab stays for them — which cannot be looked at on a machine
/// where it is installed and logged in, which is every machine this is
/// developed on.
///
/// **In the real frame, not on a card.** These states are centred in a column
/// the reader can drag between 320px and half the window, so a card the page
/// chose the width of answers the wrong question. [RightPanel] takes faked
/// props like anything else here, so the pane wears its own tab row, its own
/// Open button and its own resize handle — drag the edge, which is the thing
/// most likely to break the layout.
const CASES: {
  id: string;
  title: string;
  note: string;
  prs: never[];
  error: PrUnavailable | null;
  loading: boolean;
}[] = [
  {
    id: "no_cli",
    title: "No gh",
    note: "The pitch, the command, somewhere to paste it. Nothing here runs anything.",
    prs: [],
    error: { kind: "no_cli" },
    loading: false,
  },
  {
    id: "not_authenticated",
    title: "gh, logged out",
    note: "Same shape, second command. Recheck only re-asks GitHub — gh has not moved.",
    prs: [],
    error: { kind: "not_authenticated" },
    loading: false,
  },
  {
    id: "loading",
    title: "Asking",
    note: "Reachable with the tab open from a sidebar mark, before the first answer lands.",
    prs: [],
    error: null,
    loading: true,
  },
  {
    id: "no_branch",
    title: "Not on a branch",
    note: "A session in a directory that is not a repo, with the tab up from a stale render.",
    prs: [],
    error: null,
    loading: false,
  },
];

function Demo() {
  const [picked, setPicked] = useState(CASES[0]);

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-10">
          <h1 className="mb-4 text-lg font-medium">PR panel — no pull request behind it</h1>

          {CASES.map((demo) => (
            <button
              key={demo.id}
              type="button"
              onClick={() => setPicked(demo)}
              className={cn(
                "max-w-sm cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors",
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

        <RightPanel
          open
          tabs={tabOrder({ pr: true, docs: false, issue: false, more: false })}
          tab="pr"
          onTabChange={() => {}}
          cwd={CWD}
          refresh={{ onRefresh: () => {}, loading: picked.loading }}
        >
          <TabBody active>
            <PrPanel
              // The one state with no branch at all, which is the pane's own
              // first check rather than anything about `gh`.
              branch={picked.id === "no_branch" ? null : "worktree-calm-sage-cedar"}
              cwd={CWD}
              prs={picked.prs}
              error={picked.error}
              loading={picked.loading}
              acting={false}
              act={async () => {}}
              refresh={() => {}}
            />
          </TabBody>
        </RightPanel>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
