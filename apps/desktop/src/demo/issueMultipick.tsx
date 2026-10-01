import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import ChatInput from "@/components/ChatInput";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { Issue } from "@/types/events";
import "../App.css";

/// The composer's `#` picker taking several issues in one visit (#388):
/// ⌘-click or ⌘⏎ adds a row and keeps the list up, a tagged row shows a check,
/// and picking it again takes its tag back out.

function row(n: number, title: string, kind: Issue["state"]["kind"]): Issue {
  return {
    tracker: "linear",
    id: `uuid-${n}`,
    identifier: `DRA-${n}`,
    title,
    url: `https://linear.app/x/issue/DRA-${n}`,
    state: { id: kind, name: kind, kind, color: "#8a8f98" },
    priority: n % 2 ? "high" : "none",
    assignee: null,
    author: null,
    labels: [],
    issueType: null,
    team: "DRA",
    project: null,
    createdAt: "2026-09-05T10:30:02Z",
    updatedAt: "2026-09-09T05:51:58Z",
    pullRequests: [],
  };
}

const ROWS: Issue[] = [
  row(173, "App shortcuts dead after the browser view hides", "started"),
  row(80, "Codex as a second harness", "unstarted"),
  row(53, "Add issue tracker integration", "unstarted"),
  row(41, "Fork a session into a new worktree", "backlog"),
];

/// Stubbed outside the component, so nothing in `src/` carries a demo seam.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "list_issues") {
      const query = args.query as { text: string | null };
      const search = (query.text ?? "").toLowerCase();
      return ROWS.filter((r) => `${r.identifier} ${r.title}`.toLowerCase().includes(search));
    }
    if (cmd === "plugin:event|listen") return 0;
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

function Demo() {
  const [sent, setSent] = useState<string | null>(null);

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-4 p-8 pb-24">
        <p className="text-ui text-muted-foreground">
          Type <code>#</code>. ⌘-click or ⌘⏎ adds a row and keeps the list open; a plain pick adds
          and closes. A tagged row shows a check, and picking it again removes the tag.
        </p>
        {sent !== null && (
          <pre data-testid="sent" className="text-ui whitespace-pre-wrap">
            {sent}
          </pre>
        )}
        <ChatInput
          onSend={(message) => setSent(message)}
          cwd="/Users/you/code/acme"
          issuesConnected
          issueTrackers={{ linear: true, github: false }}
          sessionId="demo-multipick"
        />
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
