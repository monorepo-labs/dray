import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import MorePanel from "@/components/MorePanel";
import RightPanel, { TabBody } from "@/components/RightPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Todo } from "@/lib/todos";
import type { SubagentRun } from "@/lib/transcript";
import type { AgentEvent, ToolResult } from "@/types/events";
import "./App.css";

/// `OpenInButton` scans for installed apps through `invoke`, which rejects
/// outside Tauri — it draws nothing rather than an empty menu, so the tab row
/// would lose a control the pane really has. Stubbed *outside* the components,
/// so nothing in `src/` carries a demo seam.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    if (cmd === "list_open_apps") return [];
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

const TODOS: Todo[] = [
  { content: "Read the grok ACP capture end to end", status: "completed", id: "1" },
  { content: "Map subagent lifecycle onto the spawning call", status: "completed", id: "2" },
  {
    content: "Draw background tasks as runs the panel can list",
    status: "in_progress",
    id: "3",
  },
  { content: "Kill the whole tree when an open fails", status: "pending", id: "4" },
  { content: "Write the fixture for a refused effort level", status: "pending", id: "5" },
];

const LONG: Todo[] = [
  ...TODOS,
  { content: "Pin the stance rule with a live measurement", status: "pending", id: "6" },
  { content: "Retire the composer strip", status: "pending", id: "7" },
  { content: "Rename the Subagents tab", status: "pending", id: "8" },
  { content: "Teach the panel when to open itself", status: "pending", id: "9" },
  { content: "Update CLAUDE.md", status: "pending", id: "10" },
  { content: "Run the whole suite once more", status: "pending", id: "11" },
];

const DONE: Todo[] = TODOS.map((todo) => ({ ...todo, status: "completed" }));

function textEvent(text: string): AgentEvent {
  return {
    id: crypto.randomUUID(),
    seq: 0,
    ts: null,
    sessionId: "demo",
    turnId: null,
    payload: { type: "message", block: null, text },
  } as unknown as AgentEvent;
}

function spawnEvent(callId: string, description: string): AgentEvent {
  return {
    id: crypto.randomUUID(),
    seq: 0,
    ts: null,
    sessionId: "demo",
    turnId: null,
    payload: {
      type: "tool_call_started",
      callId,
      name: "spawn_subagent",
      toolType: "subagent_spawn",
      input: { description },
      rawInput: null,
      title: null,
    },
  } as unknown as AgentEvent;
}

const RUNS: SubagentRun[] = [
  {
    id: "call-1",
    taskId: "task-1",
    label: "explore",
    description: "Find every place the effort ladder is read",
    status: "Reading harness/fx/catalog.rs",
    lastTool: "Grep",
    done: false,
    background: false,
    usage: null,
    events: [textEvent("Three readers so far: the guess, the gateway, a live session.")],
    inline: false,
    spawn: spawnEvent("call-1", "Find every place the effort ladder is read"),
  },
  {
    id: "call-2",
    taskId: null,
    label: "review",
    description: "Check the grok mapper against the captured wire",
    status: null,
    lastTool: "Read",
    done: true,
    background: false,
    usage: null,
    events: [textEvent("`rawOutput` needs no rename_all — every field would read None for ever.")],
    inline: false,
    spawn: spawnEvent("call-2", "Check the grok mapper against the captured wire"),
  },
];

const RESULTS = new Map<string, ToolResult>();

const CASES: {
  id: string;
  title: string;
  note: string;
  todos: Todo[] | null;
  runs?: SubagentRun[];
}[] = [
  {
    id: "working",
    title: "Mid-list",
    note: "Two done, one running, two to go. The ordinary state.",
    todos: TODOS,
  },
  {
    id: "todo-only",
    title: "No subagents",
    note: "The section is gone rather than empty — a heading over nothing says nothing.",
    todos: TODOS,
    runs: [],
  },
  {
    id: "long",
    title: "Eleven items",
    note: "Past the section's cap, so the list scrolls and the runs keep their space.",
    todos: LONG,
  },
  {
    id: "done",
    title: "Finished",
    note: "Kept rather than dropped — what the turn did, after it did it.",
    todos: DONE,
  },
  {
    id: "none",
    title: "No list",
    note: "A session that never planned. Subagents alone.",
    todos: null,
  },
];

/// The More tab on its own, with a task list and two runs behind it.
///
/// It exists to answer one thing — what a checklist written for the transcript
/// looks like in a 32rem pane it has to share with a run list — which needs
/// both sections filled and a real agent to fill them. Drag the pane's edge:
/// the narrow end is where this is most likely to fall apart. **Delete the page
/// once it has answered.**
function ModeToggle({
  mode,
  onFlip,
}: {
  mode: "dark" | "light";
  onFlip: (next: "dark" | "light") => void;
}) {
  const flip = () => {
    const next = mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.mode = next;
    document.documentElement.classList.toggle("dark", next === "dark");
    onFlip(next);
  };

  return (
    <button
      type="button"
      onClick={flip}
      className="mb-4 max-w-sm cursor-pointer rounded-lg border border-border/60 px-3 py-2 text-left text-ui hover:bg-sidebar-accent/50"
    >
      Mode: {mode}
    </button>
  );
}

/// `--accent-add`, live, so the green can be dialled rather than guessed at one
/// value per round trip. It writes the token inline on the document, which
/// out-ranks the palette block, so the checklist beside it — and the diff
/// colours, and everything else spending that token — move with the sliders.
///
/// The value prints under the controls: copy it into App.css's palette block.
/// Delete this the moment a green is settled.
/// Whatever the palette block currently says, read off the document rather than
/// held as a literal here — a copy would be a second statement of the value,
/// free to disagree with App.css the moment one of them moves, which is exactly
/// what makes a picker useless: it would open on the old green and write it
/// back over the new one on the first render.
function currentAccent(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent-add");
  const parts = raw.match(/-?[\d.]+/g);
  if (!parts || parts.length < 3) return [0.7, 0.15, 163];
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function GreenPicker() {
  const [seedL, seedC, seedH] = currentAccent();
  const [lightness, setLightness] = useState(seedL);
  const [chroma, setChroma] = useState(seedC);
  const [hue, setHue] = useState(seedH);
  // Nothing is written until a slider moves, or the page could never show what
  // the palette itself draws.
  const [touched, setTouched] = useState(false);

  const value = `oklch(${lightness} ${chroma} ${hue})`;
  if (touched) document.documentElement.style.setProperty("--accent-add", value);

  const rows: [string, number, number, number, number, (n: number) => void][] = [
    ["Lightness", lightness, 0, 1, 0.005, setLightness],
    ["Chroma", chroma, 0, 0.3, 0.005, setChroma],
    ["Hue", hue, 0, 360, 1, setHue],
  ];

  return (
    <div className="mb-6 flex max-w-sm flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <span className="size-6 shrink-0 rounded-md bg-accent-add" />
        <code className="text-xs">{value}</code>
      </div>

      {rows.map(([label, current, min, max, step, set]) => (
        <label key={label} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={current}
            onChange={(event) => {
              setTouched(true);
              set(Number(event.target.value));
            }}
            className="min-w-0 flex-1"
          />
          <span className="w-12 shrink-0 text-right font-mono tabular-nums">{current}</span>
        </label>
      ))}

      {/* The whole point of the token is that everything spending it moves
          together, so a tick beside a `+12 −3` is the honest preview. */}
      <div className="flex items-center gap-3 text-chat">
        <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden>
          <rect width="16" height="16" rx="6" className="fill-accent-add" />
          <path
            d="m4.6 8.3 2.2 2.2 4.6-4.8"
            fill="none"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-background"
          />
        </svg>
        <span className="font-mono text-accent-add">+12</span>
        <span className="font-mono text-destructive">−3</span>
      </div>
    </div>
  );
}

function Demo() {
  const [picked, setPicked] = useState(CASES[0]);
  // Seeded from what the pre-paint script settled, never from a literal — this
  // page is about a colour, so opening on the mode the reader is not in is the
  // one thing it must not do.
  const [mode, setMode] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.mode === "dark" ? "dark" : "light",
  );

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-10">
          <h1 className="mb-4 text-lg font-medium">More panel — todos beside subagents</h1>

          {/* The checklist's marks are the one thing here that reads
              differently per ramp, so the page has to be able to flip. */}
          <ModeToggle
            mode={mode}
            onFlip={(next) => {
              // Drop any override first, or the picker remounts and seeds
              // itself from the *last mode's* pick instead of the new ramp's
              // own value — which is the one thing it exists to show.
              document.documentElement.style.removeProperty("--accent-add");
              setMode(next);
            }}
          />
          <GreenPicker key={mode} />


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

        <RightPanel open more tab="more" onTabChange={() => {}} cwd="/Users/you/code/dray">
          <TabBody active>
            <MorePanel
              todos={picked.todos}
              subagents={{
                runs: picked.runs ?? RUNS,
                selectedId: null,
                resultByCallId: RESULTS,
                live: true,
                onSelect: () => {},
                onStopTask: () => {},
              }}
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
