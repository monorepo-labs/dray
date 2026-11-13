import { BookOpen, Brain, ChevronDown, ChevronRight, Lightbulb, ScrollText, Undo2 } from "lucide-react";
import React, { useEffect, useRef, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import DiffWorkerPool from "@/components/DiffWorkerPool";
import { BotBubble, LearnedLine } from "@/components/chat/BotTranscript";
import DiffView from "@/components/chat/DiffView";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { useCodeThemeWithMode } from "@/hooks/useCodeTheme";
import { cn } from "@/lib/utils";
import type { LearnedFile } from "@/types/events";
import "../App.css";

/// The bot chat's "Learned" row: F is the real one, A to E the takes it was picked
/// from, each drawn closed, open and undone in a slice of chat. Data is faked; the
/// bubble, diff and buttons are the app's own. Undo here only flips the state.
type Lesson = { file: LearnedFile; before: string; after: string };

const RULE: Lesson = {
  file: {
    path: "INSTRUCTIONS.md",
    kind: "instructions",
    change: "changed",
    summary: "Check a sandbox's Claude login before forking it: an expired login fails every task started there",
  },
  before: "# Ops\n\nJob: fork Boat sandboxes for tasks and keep them healthy.\n",
  after:
    "# Ops\n\nJob: fork Boat sandboxes for tasks and keep them healthy.\n\n## Rules\n\n- Check a sandbox's Claude login before forking it: an expired login fails every task started there.\n",
};

const SKILL: Lesson = {
  file: {
    path: ".claude/skills/fork-sandbox/SKILL.md",
    kind: "skill",
    change: "added",
    summary: "Fork a Boat sandbox for a task, checking its logins first",
  },
  before: "",
  after:
    "---\nname: fork-sandbox\ndescription: Fork a Boat sandbox for a task, checking its logins first\n---\n\n1. Run `scripts/check-login.sh <box>`; stop and tell the user if it fails.\n2. `boat fork <box>` and wait for it to boot.\n3. Start the task with `dray session new --machine <fork>`.\n",
};

const MEMORY: Lesson = {
  file: { path: "memory/2026-11-13-sandboxes.md", kind: "memory", change: "added", summary: "Sandboxes live in the acme org" },
  before: "",
  after: "---\ndescription: Sandboxes live in the acme org\n---\n\nForks must stay in acme or billing breaks.\n",
};

const KIND: Record<string, { label: string; icon: typeof Lightbulb; hue: number }> = {
  instructions: { label: "Rule", icon: ScrollText, hue: 80 },
  skill: { label: "Skill", icon: BookOpen, hue: 250 },
  memory: { label: "Memory", icon: Brain, hue: 295 },
};

type ChipProps = { lesson: Lesson; open: boolean; undone: boolean; onToggle: () => void; onUndo: () => void };

function Diff({ lesson }: { lesson: Lesson }) {
  return <DiffView sides={{ path: lesson.file.path, oldText: lesson.before, newText: lesson.after }} />;
}

function UndoButton({ onUndo, variant = "ghost" }: { onUndo: () => void; variant?: "ghost" | "outline" }) {
  return (
    <Button variant={variant} size="xs" className="text-muted-foreground" onClick={onUndo}>
      <Undo2 data-icon="inline-start" />
      Undo
    </Button>
  );
}

function UndoneNote() {
  return <span className="text-[12px] text-muted-foreground/70">Undone</span>;
}

/// A: a filled pill. Opens to a bordered card, the path and Undo in its footer.
function Pill({ lesson, open, undone, onToggle, onUndo }: ChipProps) {
  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full bg-muted/70 py-1 pr-2 pl-2.5 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Lightbulb className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="shrink-0">Learned</span>
        <span className={cn("min-w-0 truncate text-foreground/80", undone && "line-through opacity-60")}>
          {lesson.file.summary}
        </span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="w-full overflow-hidden rounded-xl border border-border/60">
          <Diff lesson={lesson} />
          <div className="flex items-center justify-between border-t border-border/60 px-3 py-1.5">
            <span className="font-mono text-[11px] text-muted-foreground">{lesson.file.path}</span>
            {undone ? <UndoneNote /> : <UndoButton onUndo={onUndo} />}
          </div>
        </div>
      )}
    </div>
  );
}

/// B: no fill until hovered, as quiet as a time label. Opens railed, like the
/// transcript's tool groups, with Undo under the diff.
function Quiet({ lesson, open, undone, onToggle, onUndo }: ChipProps) {
  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="-mx-1.5 flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-ui text-muted-foreground transition-colors hover:bg-muted/60"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0">Learned</span>
        <span className={cn("min-w-0 truncate", undone && "line-through opacity-60")}>{lesson.file.summary}</span>
        {undone && <UndoneNote />}
      </button>
      {open && (
        <div className="flex w-full flex-col gap-2 border-l border-border/60 pl-3">
          <div className="overflow-hidden rounded-lg border border-border/60">
            <Diff lesson={lesson} />
          </div>
          {!undone && (
            <div>
              <UndoButton onUndo={onUndo} variant="outline" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// C: a capsule naming what kind of lesson it is, tinted by kind. Opens to a
/// card whose header repeats the kind and path with Undo at its right.
function Kind({ lesson, open, undone, onToggle, onUndo }: ChipProps) {
  const kind = KIND[lesson.file.kind];
  const Icon = kind.icon;
  const tint = { "--k-wash": `oklch(0.72 0.12 ${kind.hue} / 0.16)`, "--k-ink": `oklch(0.6 0.13 ${kind.hue})` } as React.CSSProperties;
  return (
    <div className="flex w-full flex-col items-start gap-1.5" style={tint}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex max-w-full cursor-pointer items-center gap-2 rounded-full border border-border/60 py-0.5 pr-2.5 pl-0.5 text-ui text-muted-foreground transition-colors hover:bg-muted/60"
      >
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-(--k-wash) px-2 py-0.5 text-[12px] font-medium text-(--k-ink)">
          <Icon className="size-3" strokeWidth={2} />
          {lesson.file.change === "added" ? `New ${kind.label.toLowerCase()}` : kind.label}
        </span>
        <span className={cn("min-w-0 truncate text-foreground/80", undone && "line-through opacity-60")}>
          {lesson.file.summary}
        </span>
      </button>
      {open && (
        <div className="w-full overflow-hidden rounded-xl border border-border/60">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
            <Icon className="size-3.5 text-(--k-ink)" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{lesson.file.path}</span>
            {undone ? <UndoneNote /> : <UndoButton onUndo={onUndo} />}
          </div>
          <Diff lesson={lesson} />
        </div>
      )}
    </div>
  );
}

/// D: shaped like the bot's own bubble, so the lesson reads as something it
/// said; open, the bubble grows to hold the diff, Undo at its foot.
function Bubble({ lesson, open, undone, onToggle, onUndo }: ChipProps) {
  return (
    <div className={cn("flex flex-col rounded-xl bg-muted/50 transition-[width]", open ? "w-full" : "max-w-[85%] self-start")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-ui"
      >
        <Lightbulb className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className={cn("min-w-0 truncate", undone && "line-through opacity-60")}>
          <span className="text-muted-foreground">Learned </span>
          {lesson.file.summary}
        </span>
        <ChevronDown className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2">
          <div className="overflow-hidden rounded-lg bg-background">
            <Diff lesson={lesson} />
          </div>
          <div className="flex justify-end">{undone ? <UndoneNote /> : <UndoButton onUndo={onUndo} />}</div>
        </div>
      )}
    </div>
  );
}

/// The lesson each F row's commit names, and what its Undo flips.
const LESSONS = new Map<string, Lesson>();
const UNDOERS = new Map<string, () => void>();

/// The real row's two calls, answered here: its diff from the lesson faked
/// above, and Undo by marking it undone after a beat, as the server's
/// `learned_undone` event would. Stubbed outside the component, so nothing in
/// `src/` carries a demo seam.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (called: string, given: Record<string, unknown>) => {
    const cmd = called === "server_invoke" ? (given.cmd as string) : called;
    const args = (called === "server_invoke" ? given.args : given) as { commit?: string };
    const lesson = LESSONS.get(args.commit ?? "");
    if (cmd === "bot_learned_diff" && lesson) return { path: lesson.file.path, before: lesson.before, after: lesson.after };
    if (cmd === "bot_undo_learned") {
      await new Promise((done) => setTimeout(done, 400));
      UNDOERS.get(args.commit ?? "")?.();
      return null;
    }
    if (cmd === "plugin:event|listen") return 0;
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

/// F, the pick, as the chat draws it: the real `LearnedLine`. `open` clicks it
/// open on mount, since the row keeps its own open state.
function RealLine({ id, lesson, open = false, undone = false }: { id: string; lesson: Lesson; open?: boolean; undone?: boolean }) {
  const commit = `c0ffee${id}`;
  LESSONS.set(commit, lesson);
  const [gone, setGone] = useState(undone);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    UNDOERS.set(commit, () => setGone(true));
  }, [commit]);
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLButtonElement>("button[aria-expanded=false]")?.click();
  }, [open]);
  return (
    <div ref={box} className="flex w-full">
      <LearnedLine sessionId="demo" commit={commit} file={lesson.file} undone={gone} />
    </div>
  );
}

/// E: one chip per turn, however many files it touched. Opens to every file,
/// each with its own diff and Undo.
function Grouped({ lessons, open, undone, onToggle, onUndo }: {
  lessons: Lesson[];
  open: boolean;
  undone: Set<string>;
  onToggle: () => void;
  onUndo: (path: string) => void;
}) {
  const all = lessons.every((l) => undone.has(l.file.path));
  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full bg-muted/70 py-1 pr-2 pl-1.5 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <span className="flex -space-x-1">
          {lessons.map((l) => {
            const Icon = KIND[l.file.kind].icon;
            return (
              <span key={l.file.path} className="flex size-5 items-center justify-center rounded-full bg-background ring-2 ring-muted">
                <Icon className="size-3" strokeWidth={1.75} />
              </span>
            );
          })}
        </span>
        <span className={cn(all && "line-through opacity-60")}>
          Learned {lessons.length === 1 ? "1 thing" : `${lessons.length} things`}
        </span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex w-full flex-col gap-3 rounded-xl border border-border/60 p-3">
          {lessons.map((l) => {
            const Icon = KIND[l.file.kind].icon;
            const gone = undone.has(l.file.path);
            return (
              <div key={l.file.path} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-ui">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className={cn("min-w-0 flex-1 truncate", gone && "line-through opacity-60")}>{l.file.summary}</span>
                  {gone ? <UndoneNote /> : <UndoButton onUndo={() => onUndo(l.file.path)} />}
                </div>
                <div className="overflow-hidden rounded-lg border border-border/60">
                  <Diff lesson={l} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/// One chip with its own open and undone state, starting where it is told.
function Live({ chip: Chip, lesson, open = false, undone = false }: {
  chip: (p: ChipProps) => ReactNode;
  lesson: Lesson;
  open?: boolean;
  undone?: boolean;
}) {
  const [isOpen, setOpen] = useState(open);
  const [isUndone, setUndone] = useState(undone);
  return (
    <Chip lesson={lesson} open={isOpen} undone={isUndone} onToggle={() => setOpen((o) => !o)} onUndo={() => setUndone(true)} />
  );
}

function LiveGroup({ open = false, undone = [] as string[] }) {
  const [isOpen, setOpen] = useState(open);
  const [gone, setGone] = useState(new Set(undone));
  return (
    <Grouped
      lessons={[RULE, SKILL, MEMORY]}
      open={isOpen}
      undone={gone}
      onToggle={() => setOpen((o) => !o)}
      onUndo={(path) => setGone((g) => new Set(g).add(path))}
    />
  );
}

/// A slice of the bot's chat around the chip, so it is judged where it lives.
function Slice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="max-w-[85%] self-end rounded-xl bg-card px-3 py-2 text-chat text-card-foreground shadow-(--shadow-card)">
        No, you should have checked the login first. Fix the script too.
      </div>
      <BotBubble>
        <p className="text-chat">Fixed. The fork script checks the Claude login first, and I added that as a rule.</p>
      </BotBubble>
      {children}
    </div>
  );
}

function Variation({ letter, name, note, children }: { letter: string; name: string; note: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border/60 p-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-ui font-medium">
          {letter}. {name}
        </h2>
        <p className="text-ui text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  );
}

const STATES = ["Closed", "Open", "Undone"] as const;

function Three({ chip }: { chip: (p: ChipProps) => ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {STATES.map((state) => (
        <div key={state} className="flex min-w-0 flex-col gap-2">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{state}</span>
          <Slice>
            <Live
              chip={chip}
              lesson={state === "Closed" ? SKILL : RULE}
              open={state === "Open"}
              undone={state === "Undone"}
            />
          </Slice>
        </div>
      ))}
    </div>
  );
}

function Demo() {
  const { pair } = useCodeThemeWithMode();
  return (
    <DiffWorkerPool pair={pair}>
      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 p-8 pb-64">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Learned chip</h1>
          <p className="max-w-3xl text-ui text-muted-foreground">
            The bot chat's Learned row: a click opens the diff in place, and Undo lives only under it. F, at the top, is
            the real row as shipped; A to E are the takes it was picked from, each closed, open and undone. Undo here only flips the state.
          </p>
        </div>
        <Variation
          letter="F"
          name="Plain line (the pick)"
          note="The real chat row: the kind in grey, then the summary, plain. A click opens the diff below, with Undo (its icon the only one) under it."
        >
          <div className="grid gap-6 lg:grid-cols-3">
            {STATES.map((state) => (
              <div key={state} className="flex min-w-0 flex-col gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{state}</span>
                <Slice>
                  <RealLine
                    id={state}
                    lesson={state === "Closed" ? SKILL : RULE}
                    open={state !== "Closed"}
                    undone={state === "Undone"}
                  />
                </Slice>
              </div>
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {[MEMORY, SKILL].map((lesson, i) => (
              <div key={lesson.file.path} className="flex min-w-0 flex-col gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {KIND[lesson.file.kind].label}, closed
                </span>
                <RealLine id={`more${i}`} lesson={lesson} />
              </div>
            ))}
          </div>
        </Variation>
        <Variation letter="A" name="Pill" note="Filled pill with a chevron. Opens to a bordered card; path and Undo in its footer.">
          <Three chip={Pill} />
        </Variation>
        <Variation letter="B" name="Quiet" note="No fill until hovered, as quiet as today's row. Opens railed like a tool group; Undo under the diff.">
          <Three chip={Quiet} />
        </Variation>
        <Variation letter="C" name="Kind badge" note="A tinted capsule says Rule, Skill or Memory. Opens to a card whose header holds the path and Undo.">
          <Three chip={Kind} />
        </Variation>
        <Variation letter="D" name="Bubble" note="Shaped like the bot's own bubble; open, the bubble grows to hold the diff, Undo at its foot.">
          <Three chip={Bubble} />
        </Variation>
        <Variation letter="E" name="Grouped" note="One chip per turn however many files it changed. Opens to each file with its own diff and Undo.">
          <div className="grid gap-6 lg:grid-cols-3">
            {STATES.map((state) => (
              <div key={state} className="flex min-w-0 flex-col gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{state}</span>
                <Slice>
                  <LiveGroup
                    open={state !== "Closed"}
                    undone={state === "Undone" ? [SKILL.file.path] : []}
                  />
                </Slice>
              </div>
            ))}
          </div>
        </Variation>
      </main>
    </DiffWorkerPool>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
      <DemoThemeBar />
    </TooltipProvider>
  </React.StrictMode>,
);
