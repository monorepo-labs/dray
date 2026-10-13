import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { ChevronRight } from "lucide-react";

import EventRow from "@/components/chat/EventRow";
import PermissionRequest from "@/components/chat/PermissionRequest";
import ToolGroupRow from "@/components/chat/ToolGroupRow";
import TurnBlock from "@/components/chat/TurnBlock";
import UserMessage from "@/components/chat/UserMessage";
import WorkingIndicator, { OrbLine } from "@/components/chat/WorkingIndicator";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { fileTarget, groupLabel, toolArgument, toolLabel, toolSummary } from "@/lib/tools";
import { buildTranscript, isToolGroup, type PendingAsk, type Turn, type WorkItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import type { AgentEvent, FileEdit, ToolResult, ToolType } from "@/types/events";
import type { JsonValue } from "@/types/serde_json/JsonValue";
import "../App.css";

/// One turn played back through the real `buildTranscript` and row components,
/// drawn several ways side by side. The question is how a turn should look
/// *while it runs* — every variation hands over to `TurnBlock` once the turn
/// closes, so they all land on the same finished view.

type Payload = AgentEvent["payload"];
/// `wait` is the pause before this event lands, at 1x. A `gate` beat waits for
/// the reader instead — a permission card holds the turn until it is answered.
type Beat = { wait: number; payload: Payload; gate?: boolean };

type Scenario = "long" | "queued" | "permission" | "short";

const SCENARIOS: { key: Scenario; label: string }[] = [
  { key: "long", label: "Long turn" },
  { key: "queued", label: "Message mid-turn" },
  { key: "permission", label: "Permission prompt" },
  { key: "short", label: "Short turn" },
];

const ROOT = "/Users/me/dray/apps/desktop/src";

const FINAL =
  "Appearance now has a **Light / Dark / System** control. System is the default and follows the OS; picking Light or Dark pins it.\n\n- `theme.ts` stores the pick and resolves System at render\n- the control sits under Theme in Appearance\n- 3 new tests cover the resolution order";

const prompt = (text: string, queued: boolean): Payload => ({
  type: "user_message",
  text,
  images: [],
  issues: [],
  baseline: null,
  queued,
  from: null,
  cwd: null,
});

/// One scripted turn. Every scenario is the same piece of work, with its one
/// difference spliced in where it would land in a real session.
function script(scenario: Scenario): { beats: Beat[]; events: AgentEvent[] } {
  const beats: Beat[] = [];
  let callCount = 0;

  const say = (wait: number, payload: Payload, gate = false) => beats.push({ wait, payload, gate });
  const msg = (text: string, wait = 1800) => say(wait, { type: "assistant_text", block: null, text });
  const think = (text: string, wait = 1200) =>
    say(wait, { type: "reasoning", block: null, text, encrypted: false });

  function call(
    name: string,
    toolType: ToolType,
    input: JsonValue,
    text: string,
    ms: number,
    exitCode: number | null = null,
    ask = false,
  ) {
    const callId = `call${callCount++}`;
    say(700, { type: "tool_call_started", callId, name, toolType, input, rawInput: null, title: null });
    if (ask) {
      // What Claude Code sends for a command outside the allow list.
      const options = [
        { id: "once", label: "Allow once", kind: "once", behavior: "allow" },
        { id: "rule", label: "Always allow pnpm add", kind: "always_rule", behavior: "allow" },
        { id: "deny", label: "Deny", kind: "deny", behavior: "deny" },
      ] as const;
      say(400, {
        type: "permission_requested",
        requestId: `req${callId}`,
        toolUseId: callId,
        toolName: name,
        displayName: null,
        title: null,
        description: "Add the testing library the new control's test needs",
        input,
        blockedPath: null,
        decisionReason: null,
        decisionReasonType: null,
        agentId: null,
        options: [...options],
      });
      say(
        0,
        {
          type: "permission_decided",
          requestId: `req${callId}`,
          toolUseId: callId,
          behavior: "allow",
          label: "Allow once",
          automatic: false,
        },
        true,
      );
    }
    say(ms, {
      type: "tool_call_completed",
      callId,
      result: { text, isError: !!exitCode, structured: null, exitCode, durationMs: ms, images: [] },
    });
  }

  const read = (path: string, ms = 500) =>
    call("Read", "file_read", { file_path: `${ROOT}/${path}` }, "1\t// …file contents…", ms);
  const grep = (pattern: string) =>
    call("Grep", "search", { pattern, path: ROOT }, "src/lib/theme.ts\nsrc/hooks/useTheme.ts", 600);
  const edit = (path: string, from: string, to: string) =>
    call("Edit", "file_edit", { file_path: `${ROOT}/${path}`, old_string: from, new_string: to }, "Updated", 900);
  const bash = (command: string, out: string, ms: number, exit = 0, ask = false) =>
    call("Bash", "shell", { command, description: command }, out, ms, exit, ask);

  say(
    0,
    prompt(
      "The settings page needs a dark-mode toggle that follows the system by default. Wire it into the theme store.",
      false,
    ),
  );
  think("Find the theme store and where Settings draws Appearance first.", 1500);
  call("Glob", "search", { pattern: "src/**/theme*.ts" }, "src/lib/theme.ts\nsrc/lib/theme.test.ts", 400);
  read("lib/theme.ts");
  read("hooks/useTheme.ts");

  if (scenario === "short") {
    msg(
      "Nothing in Settings writes the mode yet — `useTheme` exposes `setMode`, so a control under Appearance is all it takes.",
      2000,
    );
  } else {
    grep("data-mode");
    read("components/SettingsPage.tsx");
    msg(
      "The theme store already tracks a mode, but nothing in Settings writes it. I'll add a three-way control under Appearance and keep System as the default.",
    );
    read("components/settings/AppearanceSettings.tsx");
    edit("lib/theme.ts", "export type Mode = \"light\" | \"dark\";", "export type Mode = \"light\" | \"dark\" | \"system\";");
    edit("components/settings/AppearanceSettings.tsx", "<ThemeSwatches />", "<ThemeSwatches />\n<ModeControl />");
    if (scenario === "queued") {
      say(900, prompt("Also give it a shortcut — ⌘⌥L already flips light and dark, so reuse that.", true));
    }
    edit("components/settings/AppearanceSettings.tsx", "import ThemeSwatches", "import ModeControl from \"./ModeControl\";\nimport ThemeSwatches");
    bash(
      "pnpm tsc --noEmit",
      "src/lib/theme.ts(41,7): error TS2322: Type '\"system\"' is not assignable to type 'ResolvedMode'.",
      3200,
      2,
    );
    if (scenario === "queued") {
      msg("Noted on the shortcut — `mode.toggle` already holds ⌘⌥L, so the control will name it in its tooltip. First, one type error.", 1400);
    } else {
      msg("One type error — `modeFor` still returns the stored mode raw. Resolving System there.", 1400);
    }
    read("lib/theme.ts", 300);
    edit("lib/theme.ts", "return mode;", "return mode === \"system\" ? systemMode() : mode;");
    bash("pnpm tsc --noEmit", "", 3000);
    grep("modeFor");
    read("lib/theme.test.ts");
    if (scenario === "permission") {
      bash("pnpm add -D @testing-library/react", "+ @testing-library/react 16.3.0", 2400, 0, true);
    }
    edit("lib/theme.test.ts", "describe(\"modeFor\", () => {", "describe(\"modeFor\", () => {\n  it(\"resolves system\", () => { … });");
    bash("pnpm test src/lib/theme.test.ts", "✓ src/lib/theme.test.ts (17 tests) 12ms", 2600);
  }

  const final = scenario === "short" ? "Added a Light / Dark / System control under Appearance." : FINAL;
  msg(final, 2200);
  say(300, {
    type: "turn_completed",
    status: "success",
    stopReason: "end_turn",
    finalText: final,
    usage: null,
    durationMs: 41000,
    head: null,
    authFailed: false,
  });

  const events = beats.map((beat, i): AgentEvent => ({
    id: `e${i}`,
    sessionId: "demo",
    harness: "claude_code",
    seq: i,
    ts: "",
    turnId: null,
    subagent: null,
    payload: beat.payload,
  }));
  return { beats, events };
}

type Ctx = {
  resultByCallId: Map<string, ToolResult>;
  editsByCallId: Map<string, FileEdit[]>;
};

// The payloads `EventRow` draws anything for, in this script.
const DRAWS = new Set(["assistant_text", "reasoning", "tool_call_started", "error"]);
const draws = (item: WorkItem) => isToolGroup(item) || DRAWS.has(item.payload.type);
const isMessage = (item: WorkItem) => !isToolGroup(item) && item.payload.type === "assistant_text";
const callsOf = (item: WorkItem): AgentEvent[] =>
  isToolGroup(item) ? item.calls : item.payload.type === "tool_call_started" ? [item] : [];
const pendingCall = (event: AgentEvent, ctx: Ctx) =>
  event.payload.type === "tool_call_started" && !ctx.resultByCallId.has(event.payload.callId);
const anyPending = (items: WorkItem[], ctx: Ctx) =>
  items.flatMap(callsOf).some((e) => pendingCall(e, ctx));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/// The turn summary's own vocabulary, so a live fold reads like the finished one.
function countLabel(items: WorkItem[]) {
  const tools = items.flatMap(callsOf).length;
  const messages = items.filter(isMessage).length;
  const parts = [tools && plural(tools, "tool call"), messages && plural(messages, "message")];
  return parts.filter(Boolean).join(" · ") || plural(items.length, "step");
}

function Item({ item, ctx }: { item: WorkItem; ctx: Ctx }) {
  return isToolGroup(item) ? (
    <ToolGroupRow group={item} {...ctx} />
  ) : (
    <EventRow event={item} {...ctx} onOpenSession={noop} />
  );
}

/// A summary line that opens onto rows — `TurnBlock`'s own toggle, restyled
/// nowhere, so a fold mid-turn reads as the same control as one after it.
function Fold({
  label,
  pending = false,
  children,
}: {
  label: ReactNode;
  pending?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <FoldButton label={label} pending={pending} open={open} onToggle={() => setOpen((o) => !o)} />
      {open && <div className="flex flex-col gap-3 border-l border-border/60 pl-3">{children}</div>}
    </div>
  );
}

function FoldButton({
  label,
  pending,
  open,
  onToggle,
}: {
  label: ReactNode;
  pending: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group/turn flex items-center gap-2 text-left text-chat text-muted-foreground"
    >
      <span className={cn("tabular-nums", pending && "shimmer-text")}>{label}</span>
      <ChevronRight
        className={cn(
          "size-3 shrink-0 transition-all",
          open ? "rotate-90 opacity-100" : "opacity-0 group-hover/turn:opacity-100",
        )}
      />
    </button>
  );
}

/// One item as a single line of text, for the variations that only name work.
function oneLine(item: WorkItem, ctx: Ctx): { label: string; detail: string | null; pending: boolean } {
  if (isToolGroup(item)) {
    const pending = anyPending([item], ctx);
    return { label: groupLabel(item.name, item.targets, pending), detail: item.target, pending };
  }
  const p = item.payload;
  if (p.type === "tool_call_started") {
    const pending = pendingCall(item, ctx);
    return { label: toolLabel(p.name, pending), detail: toolSummary(p.name, p.toolType, p.input), pending };
  }
  if (p.type === "assistant_text") return { label: p.text.split("\n")[0], detail: null, pending: false };
  return { label: "Thought", detail: null, pending: false };
}

type Variant = {
  key: string;
  title: string;
  blurb: string;
  /// Draws its own wait, so the shared working indicator stays off.
  ownsWait?: boolean;
  Body: (props: { turn: Turn; ctx: Ctx }) => ReactNode;
};

/// Everything older than the newest `KEEP` rows folds into a line that counts up.
const KEEP = 3;

function Rolling({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const rows = turn.work.filter(draws);
  const hidden = rows.slice(0, Math.max(0, rows.length - KEEP));
  const shown = rows.slice(hidden.length);
  return (
    <>
      {hidden.length > 0 && (
        <Fold label={countLabel(hidden)}>
          {hidden.map((item) => (
            <Item key={key(item)} item={item} ctx={ctx} />
          ))}
        </Fold>
      )}
      {shown.map((item) => (
        <Item key={key(item)} item={item} ctx={ctx} />
      ))}
    </>
  );
}

function AtMessages({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const out: ReactNode[] = [];
  let run: WorkItem[] = [];
  for (const item of turn.work.filter(draws)) {
    if (!isMessage(item)) {
      run.push(item);
      continue;
    }
    if (run.length > 0) {
      const folded = run;
      out.push(
        <Fold key={`f${key(item)}`} label={countLabel(folded)}>
          {folded.map((i) => (
            <Item key={key(i)} item={i} ctx={ctx} />
          ))}
        </Fold>,
      );
    }
    out.push(<Item key={key(item)} item={item} ctx={ctx} />);
    run = [];
  }
  // The stretch since the last message is what is happening now, so it stays open.
  for (const item of run) out.push(<Item key={key(item)} item={item} ctx={ctx} />);
  return <>{out}</>;
}

function StatusLine({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const rows = turn.work.filter(draws);
  const lastMessage = rows.filter(isMessage).at(-1);
  const last = rows.at(-1);
  const now = last && !isMessage(last) ? oneLine(last, ctx) : null;
  const label = now?.pending ? `${now.label} ${now.detail ?? ""}` : "Thinking";
  const steps = rows.filter((r) => !isMessage(r)).length;

  return (
    <>
      {open
        ? rows.map((item) => <Item key={key(item)} item={item} ctx={ctx} />)
        : lastMessage && <Item item={lastMessage} ctx={ctx} />}
      <button type="button" onClick={() => setOpen((o) => !o)} className="group/turn text-left">
        <OrbLine state="working" label={<span className="truncate">{label}</span>}>
          <span className="shrink-0 text-chat text-muted-foreground/60 tabular-nums">
            {plural(steps, "step")}
          </span>
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-all",
              open ? "rotate-90" : "opacity-0 group-hover/turn:opacity-100",
            )}
          />
        </OrbLine>
      </button>
    </>
  );
}

const LINE = 24;
const WINDOW = 3;

function Ticker({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const rows = turn.work.filter(draws);
  const overflow = rows.length > WINDOW;

  return (
    <>
      <FoldButton
        label={countLabel(rows)}
        pending={false}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open ? (
        rows.map((item) => <Item key={key(item)} item={item} ctx={ctx} />)
      ) : (
        <div
          className={cn(
            "overflow-hidden",
            overflow && "[mask-image:linear-gradient(to_bottom,transparent,black_70%)]",
          )}
          style={{ height: LINE * WINDOW }}
        >
          <div
            className="transition-transform duration-300 ease-out"
            style={{ transform: `translateY(${Math.min(0, WINDOW - rows.length) * LINE}px)` }}
          >
            {rows.map((item) => {
              const line = oneLine(item, ctx);
              return (
                <div
                  key={key(item)}
                  className="flex items-center gap-2 text-chat"
                  style={{ height: LINE }}
                >
                  <span
                    className={cn(
                      "min-w-0 shrink-0",
                      isMessage(item) ? "truncate text-foreground" : "text-muted-foreground",
                      line.pending && "shimmer-text",
                    )}
                  >
                    {line.label}
                  </span>
                  {line.detail && (
                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                      {line.detail}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

type PhaseKind = "explore" | "edit" | "shell" | "solo";
type Phase = { kind: PhaseKind; events: AgentEvent[] };

function phaseKind(event: AgentEvent): PhaseKind | null {
  const p = event.payload;
  if (p.type === "reasoning") return null;
  if (p.type !== "tool_call_started") return "solo";
  if (p.toolType === "file_read" || p.toolType === "search") return "explore";
  if (p.toolType === "file_edit") return "edit";
  if (p.toolType === "shell") return "shell";
  return "solo";
}

/// Reads and searches merge whether or not they are back to back; edits and
/// commands merge with their own kind; a message always breaks a phase.
/// Reasoning joins whatever phase it lands in rather than breaking it.
function phases(turn: Turn): Phase[] {
  const out: Phase[] = [];
  const events = turn.work.flatMap((i) => (isToolGroup(i) ? i.calls : [i])).filter(draws);
  for (const event of events as AgentEvent[]) {
    const kind = phaseKind(event);
    const last = out.at(-1);
    if (last && (kind === null || (kind === last.kind && kind !== "solo"))) last.events.push(event);
    else out.push({ kind: kind ?? "solo", events: [event] });
  }
  return out;
}

function phaseLabel(phase: Phase, pending: boolean) {
  const calls = phase.events.filter((e) => e.payload.type === "tool_call_started");
  const verb = (live: string, done: string) => (pending ? live : done);
  if (phase.kind === "explore") {
    const files = new Set<string>();
    let searches = 0;
    for (const e of calls) {
      if (e.payload.type !== "tool_call_started") continue;
      const path = fileTarget(e.payload.toolType, e.payload.input);
      if (path) files.add(path);
      else searches++;
    }
    const parts = [files.size && plural(files.size, "file"), searches && plural(searches, "search")];
    return `${verb("Exploring", "Explored")} ${parts.filter(Boolean).join(", ").replace("searchs", "searches")}`;
  }
  if (phase.kind === "edit") {
    const files = new Set(
      calls.map((e) => (e.payload.type === "tool_call_started" ? fileTarget("file_edit", e.payload.input) : "")),
    );
    return `${verb("Editing", "Edited")} ${plural(files.size, "file")}`;
  }
  return `${verb("Running", "Ran")} ${plural(calls.length, "command")}`;
}

function PhaseNode({ phase, ctx }: { phase: Phase; ctx: Ctx }) {
  const calls = phase.events.filter((e) => e.payload.type === "tool_call_started");
  if (phase.kind === "solo" || calls.length < 2) {
    return phase.events.map((e) => <Item key={e.id} item={e} ctx={ctx} />);
  }
  const pending = calls.some((e) => pendingCall(e, ctx));
  return (
    <Fold label={phaseLabel(phase, pending)} pending={pending}>
      {phase.events.map((e) => (
        <Item key={e.id} item={e} ctx={ctx} />
      ))}
    </Fold>
  );
}

function Phases({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  return phases(turn).map((phase) => <PhaseNode key={phase.events[0].id} phase={phase} ctx={ctx} />);
}

const PHASE_KEEP = 2;

function PhasesRolling({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const all = phases(turn);
  const hidden = all.slice(0, Math.max(0, all.length - PHASE_KEEP));
  const shown = all.slice(hidden.length);
  return (
    <>
      {hidden.length > 0 && (
        <Fold label={countLabel(hidden.flatMap((p) => p.events))}>
          {hidden.map((phase) => (
            <PhaseNode key={phase.events[0].id} phase={phase} ctx={ctx} />
          ))}
        </Fold>
      )}
      {shown.map((phase) => (
        <PhaseNode key={phase.events[0].id} phase={phase} ctx={ctx} />
      ))}
    </>
  );
}

/// The transcript before #486: every row flat until the turn closes.
function Old({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  return turn.work.map((item) => <Item key={key(item)} item={item} ctx={ctx} />);
}

const VARIANTS: Variant[] = [
  {
    key: "old",
    title: "Old",
    blurb: "The transcript before #486: every row flat while the turn runs.",
    Body: Old,
  },
  {
    key: "today",
    title: "In the app",
    blurb: "The real TurnBlock: newest 5 rows, older ones slide up under the summary line and fade out (#486).",
    Body: () => null,
  },
  {
    key: "rolling",
    title: "Rolling fold",
    blurb: `The finished summary line exists from the start and counts up. The newest ${KEEP} rows stay under it.`,
    Body: Rolling,
  },
  {
    key: "messages",
    title: "Fold at messages",
    blurb: "Each message folds the work before it. Messages stay visible; the stretch since the last one stays open.",
    Body: AtMessages,
  },
  {
    key: "status",
    title: "One status line",
    blurb: "No tool rows. The orb names what is running now; the latest message sits above it. Click to open.",
    ownsWait: true,
    Body: StatusLine,
  },
  {
    key: "ticker",
    title: "Activity ticker",
    blurb: `A ${WINDOW}-line window that slides as work lands. Height never grows. The count opens the full list.`,
    Body: Ticker,
  },
  {
    key: "phases",
    title: "Phase grouping",
    blurb: "Reads and searches merge even when not back to back; edits and commands group with their own kind.",
    Body: Phases,
  },
  {
    key: "phases-rolling",
    title: "Phases + rolling fold",
    blurb: `Phase grouping, with everything but the newest ${PHASE_KEEP} phases folded into the counting line.`,
    Body: PhasesRolling,
  },
];

const noop = () => {};
const key = (item: WorkItem) => (isToolGroup(item) ? item.key : item.id);

function Pane({
  variant,
  turn,
  ctx,
  running,
  subagentById,
  asks,
  onRespond,
}: {
  variant: Variant;
  turn: Turn;
  ctx: Ctx;
  running: boolean;
  subagentById: ReturnType<typeof buildTranscript>["subagentById"];
  asks: PendingAsk[];
  onRespond: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const waiting = running && !anyPending(turn.work, ctx) && !variant.ownsWait;
  const footer = waiting ? <WorkingIndicator /> : undefined;
  const opening = turn.prompt?.payload;

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex flex-col gap-1 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">{variant.title}</h2>
        <p className="text-xs text-muted-foreground">{variant.blurb}</p>
      </header>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex h-[640px] flex-col gap-4 overflow-y-auto px-5 py-5"
      >
        {!running || variant.key === "today" ? (
          <TurnBlock
            turn={turn}
            subagentById={subagentById}
            {...ctx}
            onOpenSubagent={noop}
            onOpenSession={noop}
            footer={footer}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {opening?.type === "user_message" && <UserMessage text={opening.text} onOpenSession={noop} />}
            <variant.Body turn={turn} ctx={ctx} />
            {footer}
          </div>
        )}
        {/* Below the turn, as `Chat` draws them. */}
        {asks.map((ask) =>
          ask.type === "permission_requested" ? (
            <PermissionRequest
              key={ask.requestId}
              description={ask.description ?? ask.toolName}
              argument={toolArgument(ask.input)}
              options={ask.options}
              onRespond={onRespond}
            />
          ) : null,
        )}
      </div>
    </section>
  );
}

const SPEEDS = [0.5, 1, 2, 4];

function Demo() {
  // Starts with the prompt on screen and nothing else.
  const [shown, setShown] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [scenario, setScenario] = useState<Scenario>("long");
  const { beats, events: all } = useMemo(() => script(scenario), [scenario]);
  // The other explorations were judged on the long turn alone; the scenarios
  // are about what ships against what it replaces.
  const variants = scenario === "long" ? VARIANTS : VARIANTS.filter((v) => v.key === "old" || v.key === "today");

  useEffect(() => {
    if (!playing || shown >= beats.length || beats[shown].gate) return;
    const timer = setTimeout(() => setShown((n) => n + 1), beats[shown].wait / speed);
    return () => clearTimeout(timer);
  }, [playing, shown, speed, beats]);

  const events = all.slice(0, shown);
  const running = !events.some((e) => e.payload.type === "turn_completed");
  const t = buildTranscript(events, running);
  const turn = t.turns.at(-1);
  const ctx: Ctx = { resultByCallId: t.resultByCallId, editsByCallId: t.editsByCallId };

  return (
    <div className="flex min-h-screen flex-col gap-5 bg-background p-6 pb-40 text-foreground">
      <DemoThemeBar />
      <div className="sticky top-0 z-10 -mx-6 -mt-6 flex flex-wrap items-center gap-3 border-b border-border bg-background/90 px-6 py-3 backdrop-blur">
        <div className="flex gap-1">
          {SCENARIOS.map((s) => (
            <Button
              key={s.key}
              size="sm"
              variant={s.key === scenario ? "secondary" : "ghost"}
              onClick={() => {
                setScenario(s.key);
                setShown(1);
                setPlaying(true);
              }}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShown((n) => Math.min(beats.length, n + 1))}>
          Step
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setShown(1);
            setPlaying(true);
          }}
        >
          Restart
        </Button>
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <Button key={s} size="sm" variant={s === speed ? "secondary" : "ghost"} onClick={() => setSpeed(s)}>
              {s}x
            </Button>
          ))}
        </div>
        <input
          type="range"
          min={1}
          max={beats.length}
          value={shown}
          onChange={(e) => {
            setPlaying(false);
            setShown(Number(e.target.value));
          }}
          className="w-64"
        />
        <span className="text-xs text-muted-foreground tabular-nums">
          {shown} / {beats.length} events · {running ? "running" : "finished"}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {variants.map((v) => (
            <Button
              key={v.key}
              size="sm"
              variant={hidden.has(v.key) ? "ghost" : "secondary"}
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(v.key)) next.add(v.key);
                  return next;
                })
              }
            >
              {v.title}
            </Button>
          ))}
        </div>
      </div>

      {turn && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(440px,1fr))] gap-4">
          {variants.filter((v) => !hidden.has(v.key)).map((v) => (
            <Pane
              key={v.key}
              variant={v}
              turn={turn}
              ctx={ctx}
              running={running}
              subagentById={t.subagentById}
              asks={t.pendingAsks}
              // Any answer lets the scripted turn carry on; the script has one road.
              onRespond={() => setShown((n) => (beats[n]?.gate ? n + 1 : n))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
    </TooltipProvider>
  </React.StrictMode>,
);
