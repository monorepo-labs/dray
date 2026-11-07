// The whole app on its new-task page with an agent update waiting, in a plain
// browser. An update can't be looked at on a machine whose agents are current,
// and the update line's demo shows it alone, not how it sits under the composer.
// Tauri's IPC is mocked, and anything not named below rejects the way `invoke`
// does outside Tauri. The update starts on its own and takes 8s, which is long
// enough to look at. Reload to see it again.

import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import type { AgentAvailability, AgentCheck, Harness, Model, Project } from "@/types/events";

const AGENTS: [Harness, string][] = [
  ["claude_code", "Claude Code"],
  ["codex", "Codex"],
];

const PROJECTS: Project[] = [
  { path: "/Users/you/code/dray", name: "dray", space: null, lastSelected: "2026-11-06T00:00:00Z" },
];

const MODELS: Model[] = [
  {
    id: "opus",
    label: "Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    arg: "opus",
    provider: "anthropic",
    acceptsImages: true,
    secondary: false,
    supportsFast: true,
  },
];

const CHECKS: AgentCheck[] = [
  { harness: "claude_code", update: { harness: "claude_code", label: "Claude Code", current: "2.1.300", latest: "2.1.310" } },
];

function answer(cmd: string): unknown {
  switch (cmd) {
    case "check_agent_updates":
      return CHECKS;
    case "update_agent":
      return new Promise((r) => setTimeout(() => r(null), 8000));
    case "agent_availability":
      return AGENTS.map(
        ([harness, label]): AgentAvailability => ({
          harness,
          label,
          available: true,
          reason: "",
          installCommand: null,
          docsUrl: null,
          loginCommand: "",
          loginHint: null,
        }),
      );
    case "list_projects":
      return PROJECTS;
    case "list_models":
      return MODELS;
    case "list_branches":
      return { current: "main", branches: ["main"], defaultBase: "main", dirty: 0 };
    case "list_servers":
    case "list_session_index_items":
    case "list_drafts":
    case "list_slash_commands":
      return [];
    case "set_app_selection":
    case "reconnect_servers":
    case "warm_file_index":
      return null;
    default:
      console.info("[demo] nothing stubbed for", cmd);
      throw `demo: nothing stubbed for ${cmd}`;
  }
}

mockConvertFileSrc("macos");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as { cmd?: string };
    return answer(cmd === "server_invoke" ? a.cmd! : cmd);
  },
  { shouldMockEvents: true },
);

// After the mock: the app's modules reach for Tauri as they load.
const { setAutoUpdateAgents, startAgentUpdateChecks } = await import("@/hooks/useAgentUpdates");
const { default: App } = await import("@/App");

// The update line's own demo shares this origin's storage and turns this off.
setAutoUpdateAgents(true);

// The real first check waits 30s after launch; this page has nothing to wait on.
const realTimeout = window.setTimeout;
window.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof window.setTimeout;
startAgentUpdateChecks();
window.setTimeout = realTimeout;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
