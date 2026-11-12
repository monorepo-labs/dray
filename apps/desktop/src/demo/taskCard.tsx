import React, { useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { ArrowUpRight, ChevronRight } from "lucide-react";

import BotAvatar from "@/components/BotAvatar";
import Orb from "@/components/Orb";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";

/// Designs for the line a task a bot started takes in the bot's chat. Every
/// one is a single line, says where the task is with the slot before its
/// title — an orb while it works or waits, its face once done — and opens the
/// task on click. Each sits in a made-up stretch of a bot chat at the chat's
/// reading width, with one task in each state.
type State = "working" | "waiting" | "done";
type Task = { id: string; title: string; state: State; last: string };

const TASKS: Task[] = [
  { id: "01a1cb10-task-working", title: "Audit the landing page for stale claims", state: "working", last: "Reading src/app/page.tsx" },
  { id: "01a1cb11-task-waiting", title: "Draft the v0.9 launch post", state: "waiting", last: "Which tone should it take, playful or plain?" },
  { id: "01a1cb12-task-done", title: "Sleep 25 then hi", state: "done", last: "Hi there! What are we working on today?" },
];

const LABEL: Record<State, string> = { working: "Working", waiting: "Waiting on you", done: "Done" };

/// The slot every design shares: the subagent row's orb while it works, the
/// waiting orb while it is held on the reader, the task's face once done.
function Slot({ task, size = 20, hovered }: { task: Task; size?: number; hovered: boolean }) {
  if (task.state === "done") {
    return (
      <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        <BotAvatar seed={task.id} avatar={undefined} follow={hovered} className="block size-full scale-[1.18]" />
      </span>
    );
  }
  return (
    <span role="img" aria-label={LABEL[task.state]} className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {task.state === "waiting" ? (
        <Orb state="waiting" size={Math.round(size * 0.9)} className="text-accent-command" />
      ) : (
        <Orb state="working" variant="gyro" size={Math.round(size * 0.9)} />
      )}
    </span>
  );
}

/// A hover-aware wrapper, since the face's eyes follow the pointer on hover.
function Hover({ children }: { children: (hovered: boolean) => ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className="w-full" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      {children(hovered)}
    </div>
  );
}

const VARIANTS: { name: string; note: string; render: (task: Task, hovered: boolean) => ReactNode }[] = [
  {
    name: "A · Chip",
    note: "Hugs its title, filled, no border. Reads as an attachment to the bot's message.",
    render: (t, h) => (
      <button type="button" className="inline-flex max-w-full cursor-pointer items-center gap-2 rounded-full bg-muted py-1 pr-3 pl-1.5 text-ui transition-colors hover:bg-muted/70">
        <Slot task={t} size={20} hovered={h} />
        <span className="truncate">{t.title}</span>
      </button>
    ),
  },
  {
    name: "B · Card",
    note: "Bordered card at a fixed width, chevron on the right. Today's shape, one line.",
    render: (t, h) => (
      <button type="button" className="group flex w-full max-w-sm cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card py-2 pr-2.5 pl-2.5 text-left shadow-(--shadow-card) transition-colors hover:bg-muted/40">
        <Slot task={t} size={22} hovered={h} />
        <span className="min-w-0 flex-1 truncate text-ui">{t.title}</span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
      </button>
    ),
  },
  {
    name: "C · Link",
    note: "No container at all, a line in the flow of the chat. Arrow shows on hover.",
    render: (t, h) => (
      <button type="button" className="group flex max-w-full cursor-pointer items-center gap-2 text-left text-ui">
        <Slot task={t} size={20} hovered={h} />
        <span className="truncate underline decoration-muted-foreground/30 underline-offset-4 group-hover:decoration-foreground">{t.title}</span>
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    ),
  },
  {
    name: "D · Inbox line",
    note: "The sidebar's bot row, flattened: title, then the task's latest line dimmed after it.",
    render: (t, h) => (
      <button type="button" className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-ui transition-colors hover:bg-muted/50">
        <Slot task={t} size={22} hovered={h} />
        <span className="shrink-0 font-medium">{t.title}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{t.last}</span>
      </button>
    ),
  },
  {
    name: "E · Event",
    note: "Centred between hairlines, the way a messenger marks someone joining.",
    render: (t, h) => (
      <button type="button" className="group flex w-full cursor-pointer items-center gap-3 text-ui">
        <span className="h-px flex-1 bg-border" />
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground group-hover:text-foreground">
          <Slot task={t} size={18} hovered={h} />
          <span className="truncate">{t.title}</span>
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>
    ),
  },
  {
    name: "F · Thread bar",
    note: "A rule down the left, like a quoted reply. Ties the task to the message above it.",
    render: (t, h) => (
      <button type="button" className="flex w-full cursor-pointer items-center gap-2.5 border-l-2 border-border py-1 pl-3 text-left text-ui transition-colors hover:border-foreground/40">
        <Slot task={t} size={20} hovered={h} />
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/60">Open</span>
      </button>
    ),
  },
  {
    name: "G · Grouped",
    note: "Tasks started together share one card, a hairline between rows.",
    render: () => null,
  },
];

function Grouped() {
  return (
    <div className="flex w-full max-w-md flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-(--shadow-card)">
      {TASKS.map((t) => (
        <Hover key={t.id}>
          {(h) => (
            <button type="button" className="group flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-ui transition-colors hover:bg-muted/40">
              <Slot task={t} size={22} hovered={h} />
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
            </button>
          )}
        </Hover>
      ))}
    </div>
  );
}

/// A stretch of a bot chat: the reader's ask, the bot's reply, its tasks, a
/// follow-up line — the same column the real chat draws.
function Chat({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-background p-6">
      <div className="max-w-[80%] self-end rounded-2xl bg-muted px-3.5 py-2 text-chat">start three tasks: audit the site, a launch post, and a hello test</div>
      <p className="text-chat">On it. I started three sessions:</p>
      <div className="flex flex-col items-start gap-2">{children}</div>
      <p className="text-chat">Each one reports back here when it's done.</p>
    </div>
  );
}

function Demo() {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-8 p-10 pb-24">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Bot task card</h1>
          <p className="text-ui text-muted-foreground">
            One line each. Slot: orb while working, waiting orb while held on you, the task's face once done. Hover a done one: its eyes follow.
          </p>
        </div>
        <div className="grid gap-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(620px, 1fr))" }}>
          {VARIANTS.map((v) => (
            <section key={v.name} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-3">
                <h2 className="text-ui font-medium">{v.name}</h2>
                <span className="text-[12px] text-muted-foreground">{v.note}</span>
              </div>
              <Chat>
                {v.name.startsWith("G")
                  ? <Grouped />
                  : TASKS.map((t) => <Hover key={t.id}>{(h) => v.render(t, h)}</Hover>)}
              </Chat>
            </section>
          ))}
        </div>
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
