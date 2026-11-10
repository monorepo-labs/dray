import React from "react";
import ReactDOM from "react-dom/client";

import AgentUpdateLine from "@/components/composer/AgentUpdateLine";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setAutoUpdateAgents, startAgentUpdateChecks } from "@/hooks/useAgentUpdates";
import type { AgentCheck } from "@/types/events";
import "../App.css";

/// The update line under the new-task composer with automatic updates off, the
/// one state with an Update button and its ⌘U keycaps (#769).
///
/// An update can't be looked at on a machine whose agents are current, so the
/// bridge answers one for Claude Code and pi. Update, or ⌘U, runs a fake
/// install of 2.5s, which also shows the line held and the caps dimmed.
const CHECKS: AgentCheck[] = [
  { harness: "claude_code", update: { harness: "claude_code", label: "Claude Code", current: "2.1.300", latest: "2.1.310" } },
  { harness: "pi", update: { harness: "pi", label: "pi", current: "0.40.0", latest: "0.41.0" } },
];

function answer(cmd: string): unknown {
  if (cmd === "check_agent_updates") return CHECKS;
  if (cmd === "update_agent") return new Promise((r) => setTimeout(() => r(null), 2500));
  throw new Error(`demo: nothing stubbed for ${cmd}`);
}

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: { cmd?: string }) =>
    answer(cmd === "server_invoke" ? args.cmd! : cmd),
};

setAutoUpdateAgents(false);

// The real first check waits 30s after launch; this page has nothing to wait on.
const realTimeout = window.setTimeout;
window.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof window.setTimeout;
startAgentUpdateChecks();
window.setTimeout = realTimeout;

function Case({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-ui text-muted-foreground">{title}</h2>
      <div className="w-[640px] rounded-lg border bg-background px-4 py-3">{children}</div>
    </section>
  );
}

function Demo() {
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col gap-8 bg-background p-10 text-foreground">
        <DemoThemeBar />
        <Case title="Ready — ⌘U or click runs it">
          <AgentUpdateLine harness="claude_code" waiting={false} />
        </Case>
        <Case title="Held — a pi turn is running">
          <AgentUpdateLine harness="pi" waiting />
        </Case>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
