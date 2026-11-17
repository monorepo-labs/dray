import type { SubagentRun } from "@/lib/transcript";
import type { AgentEvent, SubagentList, SubagentSummary } from "@/types/events";

/// Fake runs for the dev-only state picker under a bot's Tasks tab, so every
/// state of the Subagents and Background tasks sections can be looked at in
/// the running app. Read only behind `import.meta.env.DEV`.
export const DEV_RUN_STATES = {
  live: "Live",
  none: "None",
  running: "Running",
  mixed: "Running + done",
  done: "Done only",
  many: "Many done",
  background: "With background",
  shells: "Background only",
} as const;

export type DevRunState = keyof typeof DEV_RUN_STATES;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function spawn(callId: string, name: string, input: Record<string, unknown>): AgentEvent {
  return {
    id: `spawn-${callId}`,
    seq: 0,
    ts: "",
    sessionId: "dev",
    harness: "claude_code",
    turnId: null,
    subagent: null,
    payload: { type: "tool_call_started", callId, name, toolType: "other", input, rawInput: null, title: null },
  } as unknown as AgentEvent;
}

function agent(id: string, description: string, opts: { status?: string; doneAgo?: number } = {}): SubagentRun {
  const done = opts.doneAgo !== undefined;
  return {
    id,
    taskId: done ? null : `task-${id}`,
    label: "general-purpose",
    description,
    status: opts.status ?? null,
    lastTool: null,
    done,
    background: false,
    usage: null,
    events: [],
    inline: false,
    opensWhenDone: false,
    spawn: spawn(id, "Agent", { description, prompt: description, subagent_type: "general-purpose" }),
    lastAt: done ? ago(opts.doneAgo!) : undefined,
  };
}

function shell(id: string, description: string, command: string): SubagentRun {
  return {
    ...agent(id, description),
    label: "local_bash",
    background: true,
    spawn: spawn(id, "Bash", { command, description, run_in_background: true }),
  };
}

const RUNNING = [
  agent("r1", "Check the release workflow logs", { status: "Reading .github/workflows/release.yml" }),
  agent("r2", "Find where PR marks are polled", { status: "Searching for prMarks" }),
];

const DONE_TITLES = [
  "Summarise yesterday's crash reports",
  "Look up the Boat sandbox TTL rules",
  "Compare two dray-serve builds by size",
  "Read the iOS Tasks sheet sort order",
  "Check which bots still run on Codex",
  "Draft the changelog entry for 0.9",
];

const SHELLS = [
  shell("s1", "Dev server", "pnpm tauri dev"),
  shell("s2", "Wait for the build log", "for i in $(seq 60); do grep -q Finished build.log && break; sleep 10; done"),
];

/// Finished runs the log holds past what the chat loaded, oldest last.
function logRuns(n: number, from: number): SubagentSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `log-${i}`,
    sessionId: "dev",
    taskId: null,
    label: "general-purpose",
    description: `${DONE_TITLES[i % DONE_TITLES.length]} (${i + 1})`,
    startedAt: ago(from + i * 47 + 5),
    endedAt: ago(from + i * 47),
  }));
}

/// The runs the chat holds and a loader standing in for `list_subagents`,
/// running ones counted in its total as the server counts them.
export function devRuns(state: Exclude<DevRunState, "live">): {
  runs: SubagentRun[];
  load: (skip: number) => Promise<SubagentList>;
} {
  const loaded = DONE_TITLES.slice(0, 4).map((t, i) => agent(`d${i}`, t, { doneAgo: 3 + i * 9 }));
  const { runs, log } = {
    none: { runs: [], log: [] },
    running: { runs: RUNNING, log: [] },
    mixed: { runs: [RUNNING[0], ...loaded], log: [] },
    done: { runs: loaded, log: [] },
    many: { runs: [RUNNING[0], ...loaded], log: logRuns(57, 60) },
    background: { runs: [...SHELLS, RUNNING[0], ...loaded], log: [] },
    shells: { runs: SHELLS, log: [] },
  }[state];
  const agents = runs.filter((r) => r.label !== "local_bash").length;
  return {
    runs,
    load: (skip) =>
      new Promise((resolve) =>
        setTimeout(() => {
          // Page 0 covers the loaded runs too, as the server's does.
          const all = [...runs.filter((r) => r.label !== "local_bash").map((r) => ({ id: r.id }) as SubagentSummary), ...log];
          resolve({ runs: all.slice(skip, skip + 20), more: all.length > skip + 20, total: agents + log.length });
        }, 400),
      ),
  };
}
