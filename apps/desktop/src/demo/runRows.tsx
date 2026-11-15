import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Square,
  SquareTerminal,
} from "lucide-react";

import AgentIcon from "@/components/AgentIcon";
import RightPanel, { TabBody, tabOrder } from "@/components/RightPanel";
import TodoList from "@/components/chat/TodoList";
import type { Todo } from "@/lib/todos";
import SubagentPanel from "@/components/SubagentPanel";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setMode, useTheme } from "@/hooks/useTheme";
import { compactTokens } from "@/lib/format";
import { isShellRun, opensTab, runningRuns, type SubagentRun } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import type { AgentEvent, Harness, ToolResult, Usage } from "@/types/events";
import "../App.css";

/// How the More tab's run list was picked (#1123), all from the same
/// `SubagentRun`s. The default view is the take that shipped, flat compact rows
/// inside the real side panel; `?set=1` is round one's five row takes beside
/// the panel as #1119 drew it, `?set=2` round two's card takes. Pick a scenario
/// at the top; every view redraws it.

const PANE = 320;

// `?mode=dark` / `?mode=light` for a screenshot taken with the bar hidden.
const forcedMode = new URLSearchParams(location.search).get("mode");
if (forcedMode === "dark" || forcedMode === "light") setMode(forcedMode);

function spawn(callId: string, name: string, input: Record<string, unknown>): AgentEvent {
  return {
    id: `spawn-${callId}`,
    seq: 0,
    ts: null,
    sessionId: "demo",
    turnId: null,
    payload: {
      type: "tool_call_started",
      callId,
      name,
      toolType: "other",
      input,
      rawInput: null,
      title: null,
    },
  } as unknown as AgentEvent;
}

const usage = (totalTokens: number) => ({ totalTokens }) as unknown as Usage;

function agent(
  id: string,
  type: string,
  description: string,
  opts: { status?: string; tokens?: number; done?: boolean; harness?: Harness; tool?: string } = {},
): SubagentRun {
  const fx = opts.harness === "fx";
  return {
    id,
    taskId: opts.done ? null : `task-${id}`,
    label: type,
    description,
    status: opts.status ?? null,
    lastTool: opts.tool ?? null,
    done: opts.done ?? false,
    background: false,
    usage: opts.tokens ? usage(opts.tokens) : null,
    events: [],
    inline: false,
    spawn: fx
      ? spawn(id, "subagent", { action: "message", agent: type, message: description })
      : spawn(id, "Agent", { description, prompt: description, subagent_type: type }),
  };
}

function shell(id: string, name: "Bash" | "Monitor", description: string, command: string): SubagentRun {
  return {
    id,
    taskId: `task-${id}`,
    label: "local_bash",
    description,
    status: null,
    lastTool: null,
    done: false,
    background: true,
    usage: null,
    events: [],
    inline: false,
    spawn: spawn(id, name, { command, description, run_in_background: true }),
  };
}

type Scenario = { id: string; title: string; harness: Harness; runs: SubagentRun[] };

const SCENARIOS: Scenario[] = [
  {
    id: "claude-many",
    title: "Claude — several at once",
    harness: "claude_code",
    runs: [
      agent("c1", "Explore", "Find every place the effort ladder is read", {
        status: "Reading harness/fx/catalog.rs",
        tokens: 18_400,
        tool: "Read",
      }),
      shell("s1", "Bash", "Start the dev app", "DISPLAY=:0 pnpm tauri dev > /tmp/dev.log 2>&1"),
      agent(
        "c2",
        "general-purpose",
        "Trace why the subagent panel keeps shimmering after an effort change respawns the child that held the task",
        { status: "Running cargo test transcript::", tokens: 41_200, tool: "Bash" },
      ),
      shell(
        "s2",
        "Monitor",
        "Wait for the window to launch",
        "tail -f /tmp/dev.log | grep --line-buffered 'target/debug/dray'",
      ),
      agent("c3", "Explore", "Check the grok mapper against the captured wire", {
        tokens: 9_800,
        done: true,
      }),
      agent(
        "c4",
        "general-purpose",
        "Write the fixture for a refused effort level and pin the reply shape with a hand-written test beside it",
        { tokens: 92_100, done: true },
      ),
    ],
  },
  {
    id: "fx-many",
    title: "fx — several",
    harness: "fx",
    runs: [
      agent("f1", "scout", "Map every caller of fx_subagent_events", {
        harness: "fx",
      }),
      agent("f2", "reviewer", "Review history.rs against the saved fx session --json output", {
        harness: "fx",
        done: true,
      }),
      agent(
        "f3",
        "writer",
        "Draft the harnesses.md section on background runs, the new message/wait call shape and why a run reads done as soon as its call returns",
        { harness: "fx", done: true },
      ),
    ],
  },
  {
    id: "one",
    title: "One running",
    harness: "claude_code",
    runs: [
      agent("o1", "Explore", "Find every place the effort ladder is read", {
        status: "Searching for effort_ladder",
        tokens: 3_100,
        tool: "Grep",
      }),
    ],
  },
  {
    id: "finished",
    title: "All finished",
    harness: "claude_code",
    runs: [
      agent("d1", "Explore", "Check the grok mapper against the captured wire", {
        tokens: 9_800,
        done: true,
      }),
      agent("d2", "general-purpose", "Write the fixture for a refused effort level", {
        tokens: 92_100,
        done: true,
      }),
    ],
  },
  {
    id: "shells",
    title: "Shells only",
    harness: "claude_code",
    runs: [
      shell("x1", "Bash", "Start the dev app", "DISPLAY=:0 pnpm tauri dev > /tmp/dev.log 2>&1"),
      shell("x2", "Bash", "Serve the docs", "pnpm --filter docs dev --port 4321"),
      shell(
        "x3",
        "Monitor",
        "Wait for the window to launch",
        "tail -f /tmp/dev.log | grep --line-buffered 'target/debug/dray'",
      ),
    ],
  },
];

/// What every take reads off a run, worked out once.
type Row = {
  run: SubagentRun;
  shell: boolean;
  opens: boolean;
  running: boolean;
  title: string;
  status: string | null;
  command: string | null;
  kind: string;
  tokens: number | null;
};

function toRow(run: SubagentRun): Row {
  const input =
    run.spawn?.payload.type === "tool_call_started"
      ? ((run.spawn.payload.input ?? {}) as Record<string, unknown>)
      : {};
  const shellRun = isShellRun(run);
  const name = run.spawn?.payload.type === "tool_call_started" ? run.spawn.payload.name : "";
  return {
    run,
    shell: shellRun,
    opens: opensTab(run),
    running: !run.done,
    title: run.description ?? run.label ?? "Subagent",
    status: run.done ? null : run.status,
    command: typeof input.command === "string" ? input.command : null,
    kind: shellRun ? name : (run.label ?? "agent"),
    tokens: run.usage?.totalTokens ?? null,
  };
}

function Mark({ row, harness, className }: { row: Row; harness: Harness; className?: string }) {
  return row.shell ? (
    <SquareTerminal aria-label="Shell" className={cn("size-3.5 shrink-0", className)} />
  ) : (
    <AgentIcon harness={harness} className={cn("size-3.5", className)} />
  );
}

function Stop({ label = "Stop" }: { label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          // Inside a row that expands on click; stopping is not expanding.
          onClick={(event) => event.stopPropagation()}
        >
          <Square className="fill-current" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/// A: two lines. The title, then what it is and what it is doing — the agent's
/// type and its live status, or a shell's command in mono.
function TakeA({ rows, harness }: { rows: Row[]; harness: Harness }) {
  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.run.id}
          className="group flex items-start gap-2.5 border-b border-border px-3 py-2.5 hover:bg-sidebar-accent/50"
        >
          <Mark row={row} harness={harness} className="mt-0.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                // `shimmer-text` is inline-block, which drops truncation
                // without a width to truncate at.
                "max-w-full truncate align-top text-ui",
                row.running && !row.shell ? "shimmer-text" : "text-sidebar-foreground",
                !row.running && "text-muted-foreground",
              )}
            >
              {row.title}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {row.shell ? (
                <span className="truncate font-mono">{row.command}</span>
              ) : (
                <>
                  <span className="shrink-0">{row.kind}</span>
                  <span className="shrink-0">·</span>
                  <span className="truncate">
                    {row.running ? (row.status ?? "Starting…") : "Done"}
                  </span>
                  {row.tokens != null && (
                    <span className="ml-auto shrink-0 pl-2 tabular-nums">
                      {compactTokens(row.tokens)}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
          {row.running && row.run.taskId ? (
            <Stop />
          ) : row.opens ? (
            <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/// B: state first. The leading glyph says running, live or done; the kind moves
/// to a small mark at the end. One line, finished rows step back to muted.
function TakeB({ rows, harness }: { rows: Row[]; harness: Harness }) {
  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.run.id}
          className="flex items-center gap-2 border-b border-border px-3 py-2 text-ui hover:bg-sidebar-accent/50"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {!row.running ? (
              <Check className="size-3.5 text-accent-add" />
            ) : row.shell ? (
              <span className="relative flex size-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-accent-add opacity-60" />
                <span className="relative size-2 rounded-full bg-accent-add" />
              </span>
            ) : (
              <Spinner className="size-3.5 text-muted-foreground" />
            )}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              row.running ? "text-sidebar-foreground" : "text-muted-foreground",
              row.shell && "font-mono text-xs",
            )}
          >
            {row.shell ? row.command : row.title}
          </span>
          {row.tokens != null && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {compactTokens(row.tokens)}
            </span>
          )}
          <Mark row={row} harness={harness} className="text-muted-foreground/70" />
          {row.running && row.run.taskId && <Stop />}
        </div>
      ))}
    </div>
  );
}

function SubHead({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
      {action}
    </div>
  );
}

/// C: grouped by state. Running above, finished under its own heading, so the
/// list reads as "what is going on" first and "what happened" after.
function TakeC({ rows, harness }: { rows: Row[]; harness: Harness }) {
  const running = rows.filter((row) => row.running);
  const done = rows.filter((row) => !row.running);
  const line = (row: Row) => (
    <div
      key={row.run.id}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-ui hover:bg-sidebar-accent/50"
    >
      <Mark row={row} harness={harness} className="text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          !row.running && "text-muted-foreground",
          row.running && !row.shell && "shimmer-text",
        )}
      >
        {row.title}
      </span>
      {row.running && row.status && (
        <span className="max-w-[40%] shrink truncate text-xs text-muted-foreground">
          {row.status}
        </span>
      )}
      {!row.running && row.tokens != null && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {compactTokens(row.tokens)}
        </span>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-1 pb-2">
      {running.length > 0 && (
        <>
          <SubHead
            action={
              running.length > 1 && (
                <Button variant="ghost" size="xs" className="-mr-2 normal-case">
                  Stop all
                </Button>
              )
            }
          >
            Running · {running.length}
          </SubHead>
          <div className="px-1">{running.map(line)}</div>
        </>
      )}
      {done.length > 0 && (
        <>
          <SubHead>Finished · {done.length}</SubHead>
          <div className="px-1">{done.map(line)}</div>
        </>
      )}
    </div>
  );
}

/// D: split by kind. Subagents are conversations and open a tab, so they read
/// like links; shells are commands and read like a terminal line.
function TakeD({ rows, harness }: { rows: Row[]; harness: Harness }) {
  const agents = rows.filter((row) => !row.shell);
  const shells = rows.filter((row) => row.shell);
  return (
    <div className="flex flex-col pb-2">
      {agents.length > 0 && (
        <>
          <SubHead>Subagents</SubHead>
          {agents.map((row) => (
            <div
              key={row.run.id}
              className="group flex items-center gap-2 px-3 py-1.5 text-ui hover:bg-sidebar-accent/50"
            >
              <span className="relative flex size-3.5 shrink-0">
                <AgentIcon
                  harness={harness}
                  className={cn("size-3.5", row.running ? "text-foreground" : "text-muted-foreground")}
                />
                {row.running && (
                  <span className="absolute -right-0.5 -bottom-0.5 size-1.5 animate-pulse rounded-full bg-accent-add ring-2 ring-background" />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  row.running ? "text-sidebar-foreground" : "text-muted-foreground",
                )}
              >
                {row.title}
              </span>
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-xs text-muted-foreground">
                {row.kind}
              </span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
            </div>
          ))}
        </>
      )}
      {shells.length > 0 && (
        <>
          <SubHead>Shells</SubHead>
          {shells.map((row) => (
            <div
              key={row.run.id}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-sidebar-accent/50"
            >
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-sidebar-foreground">
                <span className="text-muted-foreground">$ </span>
                {row.command}
              </span>
              <Stop label="Stop this command" />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/// E: cards. Room for a two-line title and a meta line, a tile holding the
/// mark, and the running state on the tile rather than on the text.
function TakeE({ rows, harness }: { rows: Row[]; harness: Harness }) {
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {rows.map((row) => (
        <div
          key={row.run.id}
          className={cn(
            "group flex items-start gap-2.5 rounded-lg border border-border px-2.5 py-2 hover:bg-sidebar-accent/50",
            !row.running && "border-transparent bg-muted/40",
          )}
        >
          <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <Mark row={row} harness={harness} className="text-muted-foreground" />
            {row.running && (
              <Spinner className="absolute -right-1 -bottom-1 size-3 rounded-full bg-background text-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "line-clamp-2 text-ui",
                row.running ? "text-sidebar-foreground" : "text-muted-foreground",
              )}
            >
              {row.title}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {row.shell ? (
                <span className="truncate font-mono">{row.command}</span>
              ) : (
                <>
                  <span className="shrink-0">{row.kind}</span>
                  {row.running && row.status && (
                    <>
                      <span>·</span>
                      <span className="truncate">{row.status}</span>
                    </>
                  )}
                  {row.tokens != null && (
                    <>
                      <span>·</span>
                      <span className="shrink-0 tabular-nums">
                        {compactTokens(row.tokens)} tokens
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          {row.running && row.run.taskId && <Stop />}
        </div>
      ))}
    </div>
  );
}

/// What a card says under its title: a shell's command, a running agent's
/// live status. A finished agent says nothing — no tokens, no agent type.
function cardMeta(row: Row): string | null {
  if (row.shell) return row.command;
  return row.running ? (row.status ?? "Starting…") : null;
}

function MetaLine({ row, spin = false }: { row: Row; spin?: boolean }) {
  const meta = cardMeta(row);
  if (!meta) return null;
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {spin && row.running && !row.shell && <Spinner className="size-3 shrink-0" />}
      <span className={cn("truncate", row.shell && "font-mono")}>{meta}</span>
    </div>
  );
}

function OpenHint({ className }: { className?: string }) {
  return (
    <ArrowUpRight
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100",
        className,
      )}
    />
  );
}

/// E1: E with the numbers and labels gone. A finished card drops its meta line
/// and its border, so it is shorter and quieter than a running one.
function TakeE1({ rows, harness }: { rows: Row[]; harness: Harness }) {
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {rows.map((row) => (
        <div
          key={row.run.id}
          className={cn(
            "group flex items-start gap-2.5 rounded-lg border px-2.5 py-2 hover:bg-sidebar-accent/50",
            row.running ? "border-border" : "border-transparent bg-muted/40",
          )}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <Mark row={row} harness={harness} className="text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1 self-center">
            <div
              className={cn(
                "line-clamp-2 text-ui",
                row.running ? "text-sidebar-foreground" : "text-muted-foreground",
              )}
            >
              {row.title}
            </div>
            <MetaLine row={row} spin />
          </div>
          {row.running && row.run.taskId ? <Stop /> : row.opens ? <OpenHint className="mt-1.5" /> : null}
        </div>
      ))}
    </div>
  );
}

/// E2: a footer strip. The title owns the card; state sits under a hairline
/// with its control at the far end — Stop while running, Open once done.
function TakeE2({ rows, harness }: { rows: Row[]; harness: Harness }) {
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {rows.map((row) => (
        <div key={row.run.id} className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-start gap-2 px-2.5 pt-2 pb-1.5">
            <Mark row={row} harness={harness} className="mt-0.5 text-muted-foreground" />
            <div
              className={cn(
                "line-clamp-2 min-w-0 flex-1 text-ui",
                row.running ? "text-sidebar-foreground" : "text-muted-foreground",
              )}
            >
              {row.title}
            </div>
          </div>
          <div className="flex h-7 items-center gap-1.5 border-t border-border bg-muted/30 pr-1 pl-2.5 text-xs text-muted-foreground">
            {!row.running ? (
              <Check className="size-3 shrink-0 text-accent-add" />
            ) : row.shell ? (
              <span className="size-1.5 shrink-0 rounded-full bg-accent-add" />
            ) : (
              <Spinner className="size-3 shrink-0" />
            )}
            <span className={cn("min-w-0 flex-1 truncate", row.shell && "font-mono")}>
              {cardMeta(row) ?? "Done"}
            </span>
            {row.running && row.run.taskId ? (
              <Button variant="ghost" size="xs" className="h-5 shrink-0 px-1.5 text-xs">
                Stop
              </Button>
            ) : row.opens ? (
              <Button variant="ghost" size="xs" className="h-5 shrink-0 gap-1 px-1.5 text-xs">
                Open <ArrowUpRight className="size-3" />
              </Button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/// E3: compact. No tile, the mark inline; one line when finished, a second
/// line only while there is something live to say.
function TakeE3({ rows, harness }: { rows: Row[]; harness: Harness }) {
  return (
    <div className="flex flex-col gap-1 p-2">
      {rows.map((row) => (
        <div
          key={row.run.id}
          className={cn(
            "group rounded-lg border px-2.5 py-1.5 hover:bg-sidebar-accent/50",
            row.running ? "border-border" : "border-transparent bg-muted/40",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Mark row={row} harness={harness} className="text-muted-foreground" />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-ui",
                row.running ? "text-sidebar-foreground" : "text-muted-foreground",
              )}
            >
              {row.title}
            </span>
            {row.running && row.run.taskId ? <Stop /> : row.opens ? <OpenHint /> : null}
          </div>
          {cardMeta(row) && (
            <div
              className={cn("truncate pl-5.5 text-xs text-muted-foreground", row.shell && "font-mono")}
            >
              {cardMeta(row)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/// E4: the tile carries the state. Running agents get a filled tile, live
/// shells a green one, finished runs a tick — the text stays plain.
function TakeE4({ rows, harness }: { rows: Row[]; harness: Harness }) {
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {rows.map((row) => (
        <div
          key={row.run.id}
          className="group flex items-center gap-2.5 rounded-lg bg-muted/40 px-2 py-2 hover:bg-muted/70"
        >
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md",
              !row.running
                ? "bg-background text-muted-foreground"
                : row.shell
                  ? "bg-accent-add/15 text-accent-add"
                  : "bg-foreground text-background",
            )}
          >
            {row.running ? (
              <Mark row={row} harness={harness} className="size-4" />
            ) : (
              <Check className="size-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "line-clamp-2 text-ui",
                row.running ? "text-sidebar-foreground" : "text-muted-foreground",
              )}
            >
              {row.title}
            </div>
            <MetaLine row={row} />
          </div>
          {row.running && row.run.taskId ? <Stop /> : row.opens ? <OpenHint /> : null}
        </div>
      ))}
    </div>
  );
}

/// E5: running cards up top in full, finished ones folded into a tight stack
/// under a count — what happened stays reachable without taking the room.
function TakeE5({ rows, harness }: { rows: Row[]; harness: Harness }) {
  const running = rows.filter((row) => row.running);
  const done = rows.filter((row) => !row.running);
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {running.map((row) => (
        <div
          key={row.run.id}
          className="flex items-start gap-2.5 rounded-lg border border-border px-2.5 py-2"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <Mark row={row} harness={harness} className="text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1 self-center">
            <div className="line-clamp-2 text-ui text-sidebar-foreground">{row.title}</div>
            {row.shell ? (
              <div className="mt-1 truncate rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                $ {row.command}
              </div>
            ) : (
              <MetaLine row={row} spin />
            )}
          </div>
          {row.run.taskId && <Stop />}
        </div>
      ))}
      {done.length > 0 && (
        <div className="overflow-hidden rounded-lg bg-muted/40">
          <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">Finished · {done.length}</div>
          {done.map((row) => (
            <div
              key={row.run.id}
              className="group flex items-center gap-2 px-2.5 py-1.5 text-ui hover:bg-muted/70"
            >
              <Mark row={row} harness={harness} className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.title}</span>
              {row.opens && <OpenHint />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Take = {
  id: string;
  name: string;
  note: string;
  Take: (props: { rows: Row[]; harness: Harness }) => React.ReactElement;
};

/// Round two, after the card direction was picked: no token counts, no agent
/// type labels. E stays first as the take they grew from.
const CARD_TAKES: Take[] = [
  { id: "E", name: "Cards (round 1)", note: "As picked, tokens and type still on it.", Take: TakeE },
  { id: "E1", name: "Quiet card", note: "E without numbers or labels; finished cards go flat.", Take: TakeE1 },
  { id: "E2", name: "Status footer", note: "State and its control on a strip under a hairline.", Take: TakeE2 },
  { id: "E3", name: "Compact", note: "No tile; one line when finished, two while live.", Take: TakeE3 },
  { id: "E4", name: "State on the tile", note: "Filled tile running, green for a live shell, tick when done.", Take: TakeE4 },
  { id: "E5", name: "Finished stack", note: "Running cards in full; finished folded under a count.", Take: TakeE5 },
];

const TAKES: Take[] = [
  { id: "A", name: "Two lines", note: "Title over type · status, or the command in mono.", Take: TakeA },
  { id: "B", name: "State first", note: "Leading spinner / live dot / tick; kind as a trailing mark.", Take: TakeB },
  { id: "C", name: "Grouped by state", note: "Running and Finished headings, Stop all on the first.", Take: TakeC },
  { id: "D", name: "Split by kind", note: "Subagents read as links with a type tag; shells as $ lines.", Take: TakeD },
  { id: "E", name: "Cards", note: "Tile with the mark, two-line title, meta line under it.", Take: TakeE },
];

const RESULTS = new Map<string, ToolResult>();

const PANEL_TODOS: Todo[] = [
  { content: "Read the grok ACP capture end to end", status: "completed", id: "1" },
  { content: "Map subagent lifecycle onto the spawning call", status: "completed", id: "2" },
  { content: "Draw background tasks as runs the panel can list", status: "in_progress", id: "3" },
  { content: "Write the fixture for a refused effort level", status: "pending", id: "4" },
];

/// The More tab as the app draws it — the real pane frame, tab row, task list
/// and `SubagentPanel` — so this view always shows what ships.
function PanelTake({ runs }: { runs: SubagentRun[] }) {
  const [selected, setSelected] = useState<string | null>(
    () => runs.find((run) => isShellRun(run))?.id ?? null,
  );
  return (
    <section className="flex flex-col gap-2">
      <div className="text-ui font-medium">As shipped in #1123</div>
      {/* The app sits the pane in a card whose ring is its edge. */}
      <div className="flex h-[720px] overflow-hidden rounded-xl ring-1 ring-border">
        <RightPanel
          open
          tabs={tabOrder({ pr: true, docs: false, issue: false, more: true })}
          tab="more"
          onTabChange={() => {}}
          widthKey="demo-run-rows"
        >
          <TabBody active>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="px-3 pt-3 pb-3">
                <TodoList todos={PANEL_TODOS} live />
              </div>
              <SubagentPanel
                runs={runs}
                selectedId={selected}
                resultByCallId={RESULTS}
                live
                onSelect={setSelected}
                onOpen={() => {}}
                onStopTask={() => {}}
              />
            </div>
          </TabBody>
        </RightPanel>
      </div>
    </section>
  );
}

function Frame({
  label,
  name,
  note,
  children,
}: {
  label: string;
  name: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section data-take={label} className="flex flex-col gap-2" style={{ width: PANE }}>
      <div>
        <div className="text-ui font-medium">
          {label} — {name}
        </div>
        <div className="text-xs text-muted-foreground">{note}</div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-background">
        <div className="px-3 pt-3 pb-2 text-ui text-muted-foreground">Background tasks / Subagents</div>
        {children}
      </div>
    </section>
  );
}

function Demo() {
  // The bar applies the stored theme by subscribing to it; with `?bare` this
  // is what still does.
  useTheme();
  const [scenario, setScenario] = useState(() => {
    const id = new URLSearchParams(location.search).get("s");
    return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
  });
  // As App hands them over: finished shells are already gone.
  const runs = runningRuns(scenario.runs, null);
  // The side panel by default; `?set=1` is round one beside the shipping
  // panel, `?set=2` the card takes.
  const set = new URLSearchParams(location.search).get("set");
  const roundOne = set === "1";
  const takes = roundOne ? TAKES : CARD_TAKES;
  const rows = runs.map(toRow);

  return (
    <TooltipProvider>
      <div className="flex min-h-full flex-col gap-6 p-8 pb-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-lg font-medium">Background tasks / Subagents —{" "}
            {roundOne ? "row takes" : set === "2" ? "card takes" : "compact, in the side panel"}
          </h1>
          <div className="flex flex-wrap gap-2">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setScenario(s);
                  const params = new URLSearchParams(location.search);
                  params.set("s", s.id);
                  history.replaceState(null, "", `?${params}`);
                }}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-ui",
                  scenario.id === s.id
                    ? "border-border bg-sidebar-accent"
                    : "border-border/60 hover:bg-sidebar-accent/50",
                )}
              >
                {s.title}
              </button>
            ))}
          </div>
        </div>

        {set !== "1" && set !== "2" ? (
          <div className="flex items-start gap-10">
            <PanelTake runs={runs} />
          </div>
        ) : (
        <div className="grid grid-cols-[repeat(6,max-content)] items-start gap-6">
          {roundOne && (
            <Frame label="Now" name="as shipped in #1119" note="The real SubagentPanel, for reference.">
              <SubagentPanel
                runs={runs}
                selectedId={null}
                resultByCallId={RESULTS}
                live
                onSelect={() => {}}
                onOpen={() => {}}
                onStopTask={() => {}}
              />
            </Frame>
          )}
          {takes.map(({ id, name, note, Take }) => (
            <Frame key={id} label={id} name={name} note={note}>
              <Take rows={rows} harness={scenario.harness} />
            </Frame>
          ))}
        </div>
        )}
      </div>
      {/* `?bare` drops the bar for a screenshot, since it sits over a column. */}
      {!new URLSearchParams(location.search).has("bare") && <DemoThemeBar />}
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
