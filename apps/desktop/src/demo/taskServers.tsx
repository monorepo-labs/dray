import { ChatBubbleOvalLeftIcon } from "@heroicons/react/16/solid";
import { ArrowUpRight, Globe, Plus, Server, SquareTerminal } from "lucide-react";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import BotAvatar from "@/components/BotAvatar";
import Segmented from "@/components/Segmented";
import GlobeFilledIcon from "@/components/icons/GlobeFilledIcon";
import { ItemTab, RowMachine } from "@/components/layout/ViewTabs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { seededAvatar } from "@/lib/botAvatar";
import { cn } from "@/lib/utils";
import "../App.css";

/// Five ways to surface a session's dev servers and open one in a tab, each
/// drawn twice: a normal session, and a bot's row with one of its tasks lit.
/// A remote server's `localhost` is this Mac's forward of it, so a remote row
/// says which machine and opens the forwarded port.

type Machine = "mac" | "boat";
type Srv = { port: number; process: string; forwarded: number };
type Task = { id: string; title: string; machine: Machine; servers: Srv[] };

const MAIN: Srv[] = [
  { port: 3000, process: "next-server", forwarded: 52011 },
  { port: 6006, process: "storybook", forwarded: 52014 },
];

const tasksFor = (two: boolean): Task[] => [
  { id: "t1", title: "Fix the pricing page", machine: "mac", servers: two ? MAIN : MAIN.slice(0, 1) },
  { id: "t2", title: "Audit the landing page", machine: "boat", servers: [{ port: 5173, process: "vite", forwarded: 52020 }] },
  { id: "t3", title: "Rename the CLI flags", machine: "mac", servers: [] },
];

const MARK = "size-4 shrink-0 text-muted-foreground";
const where = (m: Machine) => (m === "mac" ? "This Mac" : "boat");
const address = (s: Srv, m: Machine) => `localhost:${m === "mac" ? s.port : s.forwarded}`;

/// A green dot that breathes, the one colour in these surfaces saying "up".
function Live({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex size-1.5 shrink-0", className)}>
      <span className="absolute inset-0 animate-ping rounded-full bg-accent-add opacity-50 [animation-duration:2s]" />
      <span className="relative size-1.5 rounded-full bg-accent-add" />
    </span>
  );
}

function ServerTip({ s, machine }: { s: Srv; machine: Machine }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <span className="font-mono">localhost:{s.port}</span> · {s.process}
      </span>
      {machine === "boat" && <span className="opacity-70">On boat, opened here as localhost:{s.forwarded}</span>}
      <span className="opacity-70">Click opens a tab · ⌘-click the system browser</span>
    </div>
  );
}

// the open tabs, shared by every variation

type Page = { key: string; srv: Srv; machine: Machine; task?: Task };

function usePages() {
  const [pages, setPages] = useState<Page[]>([]);
  const [active, setActive] = useState("chat");
  const open = (srv: Srv, machine: Machine, task?: Task) => {
    const key = `${task?.id ?? "s"}:${srv.port}`;
    setPages((p) => (p.some((x) => x.key === key) ? p : [...p, { key, srv, machine, task }]));
    setActive(key);
  };
  const close = (key: string) => {
    setPages((p) => p.filter((x) => x.key !== key));
    setActive((a) => (a === key ? "chat" : a));
  };
  return { pages, active, setActive, open, close, isOpen: (key: string) => pages.some((p) => p.key === key) };
}
type Pages = ReturnType<typeof usePages>;

function PageTabs({ p }: { p: Pages }) {
  return p.pages.map((page) => (
    <ItemTab
      key={page.key}
      icon={<GlobeFilledIcon className={MARK} />}
      // The real port, as the agent says it; the glyph says it is boat's.
      label={`localhost:${page.srv.port}`}
      active={p.active === page.key}
      onPick={() => p.setActive(page.key)}
      onClose={() => p.close(page.key)}
      machine={page.machine === "boat" ? "boat" : undefined}
    />
  ));
}

function FakePage({ page }: { page: Page }) {
  const title = page.srv.process === "storybook" ? "Storybook" : page.srv.process === "vite" ? "Acme — home" : "Acme — pricing";
  return (
    <div className="m-2 flex flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex h-8 items-center gap-2 border-b border-border px-3 font-mono text-ui text-muted-foreground">
        <Globe className="size-3.5" />
        {address(page.srv, page.machine)}
        {page.machine === "boat" && <span className="font-sans">· boat's :{page.srv.port}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-3 bg-white p-6 text-neutral-900">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-neutral-100" />
          ))}
        </div>
      </div>
    </div>
  );
}

// the window frame

function Frame({
  tabs,
  farEnd,
  body,
  aboveComposer,
  side,
  sideRight,
}: {
  tabs: React.ReactNode;
  farEnd?: React.ReactNode;
  body: React.ReactNode;
  aboveComposer?: React.ReactNode;
  side?: React.ReactNode;
  sideRight?: React.ReactNode;
}) {
  return (
    <div className="flex h-[420px] w-[640px] overflow-hidden rounded-xl border border-border bg-background shadow-card">
      {side}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-0.5 bg-surface-frame px-2">
          {tabs}
          {farEnd}
        </div>
        {body}
        {aboveComposer}
      </div>
      {sideRight}
    </div>
  );
}

function Composer({ above }: { above?: React.ReactNode }) {
  return (
    <div className="shrink-0 px-3 pb-3">
      {above}
      <div className="flex h-16 items-start rounded-2xl border border-border bg-composer p-3 text-ui text-muted-foreground">
        Message the agent…
      </div>
    </div>
  );
}

function ToolRow({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-center gap-2 text-ui text-muted-foreground">
      <SquareTerminal className="size-3.5" />
      Ran <span className="font-mono text-foreground">{cmd}</span>
      <span>in the background</span>
    </div>
  );
}

const CMD: Record<number, string> = { 3000: "pnpm dev", 6006: "pnpm storybook", 5173: "pnpm vite" };

/// The chat stub: a prompt, then one background tool row per server, and
/// `card` drawn under each — variation C's slot, empty for the rest.
function Chat({
  prompt,
  servers,
  card,
}: {
  prompt: string;
  servers: Srv[];
  card?: (s: Srv) => React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4 text-ui">
      <div className="self-end rounded-xl bg-primary px-3 py-2 text-primary-foreground">{prompt}</div>
      {servers.map((s) => (
        <div key={s.port} className="flex flex-col gap-2">
          <ToolRow cmd={CMD[s.port] ?? "pnpm dev"} />
          {card?.(s)}
        </div>
      ))}
      <p>
        {servers.length === 0 ? "Done — nothing to run for this one." : "It's up. I've changed the pricing cards; have a look."}
      </p>
    </div>
  );
}

// one normal session and one bot row, parametrised by variation

type Slots = {
  /// Drawn at the titlebar's far end, before the machine and branch.
  chip?: (servers: Srv[], machine: Machine, open: (s: Srv) => void, isOpen: (s: Srv) => boolean) => React.ReactNode;
  strip?: (servers: Srv[], machine: Machine, open: (s: Srv) => void) => React.ReactNode;
  card?: (s: Srv, machine: Machine, open: (s: Srv) => void, isOpen: boolean) => React.ReactNode;
  plus?: (servers: Srv[], machine: Machine, open: (s: Srv) => void, heading: string) => React.ReactNode;
  sessionSide?: (servers: Srv[], machine: Machine, open: (s: Srv) => void) => React.ReactNode;
  botSide?: (tasks: Task[], lit: string, open: (s: Srv, t: Task) => void) => React.ReactNode;
};

const plainPlus = (
  <button type="button" aria-label="New tab" className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5">
    <Plus className="size-3.5" />
  </button>
);

function SessionWindow({ slots, machine, servers }: { slots: Slots; machine: Machine; servers: Srv[] }) {
  const p = usePages();
  const open = (s: Srv) => p.open(s, machine);
  const isOpen = (s: Srv) => p.isOpen(`s:${s.port}`);
  const page = p.pages.find((x) => x.key === p.active);
  return (
    <Frame
      side={slots.sessionSide?.(servers, machine, open)}
      tabs={
        <>
          <ItemTab
            icon={<ChatBubbleOvalLeftIcon className={MARK} />}
            label="Fix the pricing page"
            active={p.active === "chat"}
            onPick={() => p.setActive("chat")}
            plain={p.pages.length === 0}
          />
          <PageTabs p={p} />
          {slots.plus ? slots.plus(servers, machine, open, machine === "mac" ? "Running locally" : "Running on boat") : plainPlus}
        </>
      }
      farEnd={
        <span className="ml-auto flex min-w-0 items-center gap-1">
          {slots.chip?.(servers, machine, open, isOpen)}
          {machine === "boat" && <RowMachine name="boat" />}
          <span className="shrink-0 pl-2 text-ui text-muted-foreground">noble-jade-quarry</span>
        </span>
      }
      body={
        page ? (
          <FakePage page={page} />
        ) : (
          <Chat
            prompt="Start the dev server and fix the pricing cards"
            servers={servers}
            card={slots.card && ((s) => slots.card!(s, machine, open, isOpen(s)))}
          />
        )
      }
      aboveComposer={!page && <Composer above={slots.strip?.(servers, machine, open)} />}
    />
  );
}

const face = (id: string) => (
  <BotAvatar seed={`task-${id}`} avatar={seededAvatar(`task-${id}`)} className="block size-4 shrink-0 scale-[1.18]" />
);

function BotWindow({ slots, tasks }: { slots: Slots; tasks: Task[] }) {
  const p = usePages();
  const [lit, setLit] = useState("t1");
  const task = tasks.find((t) => t.id === lit) ?? tasks[0];
  const shown = tasks.slice(0, 2);
  const pick = (id: string) => {
    setLit(id);
    p.setActive("chat");
  };
  const page = p.pages.find((x) => x.key === p.active);
  const open = (s: Srv, t: Task = task) => p.open(s, t.machine, t);
  const isOpen = (s: Srv) => p.isOpen(`${task.id}:${s.port}`);
  return (
    <Frame
      sideRight={slots.botSide?.(tasks, lit, (s, t) => open(s, t))}
      tabs={
        <>
          <ItemTab icon={<ChatBubbleOvalLeftIcon className={MARK} />} label="Dray" active={false} onPick={() => {}} fixed />
          {shown.map((t) => (
            <ItemTab
              key={t.id}
              icon={face(t.id)}
              label={t.title}
              active={p.active === "chat" && lit === t.id}
              onPick={() => pick(t.id)}
              onClose={() => {}}
              machine={t.machine === "boat" ? "boat" : undefined}
            />
          ))}
          <PageTabs p={p} />
          {slots.plus ? slots.plus(task.servers, task.machine, (s) => open(s), `${task.title} · ${task.machine === "mac" ? "locally" : "on boat"}`) : plainPlus}
        </>
      }
      farEnd={
        <span className="ml-auto flex min-w-0 items-center gap-1">
          {!page && slots.chip?.(task.servers, task.machine, (s) => open(s), isOpen)}
          {!page && task.machine === "boat" && <RowMachine name="boat" />}
        </span>
      }
      body={
        page ? (
          <FakePage page={page} />
        ) : (
          <Chat
            prompt={task.id === "t2" ? "Audit the landing page on a sandbox" : "Fix the pricing cards"}
            servers={task.servers}
            card={slots.card && ((s) => slots.card!(s, task.machine, (x) => open(x), isOpen(s)))}
          />
        )
      }
      aboveComposer={!page && <Composer above={slots.strip?.(task.servers, task.machine, (s) => open(s))} />}
    />
  );
}

// A: a chip at the titlebar's far end

const chipClass = "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-ui text-muted-foreground hover:bg-foreground/5 hover:text-foreground";

const A: Slots = {
  chip: (servers, machine, open) => {
    if (servers.length === 0) return null;
    if (servers.length === 1) {
      const s = servers[0];
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={chipClass} onClick={() => open(s)}>
              <Live />
              <span className="font-mono">:{s.port}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <ServerTip s={s} machine={machine} />
          </TooltipContent>
        </Tooltip>
      );
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={chipClass}>
            <Live />
            <span className="font-mono">:{servers[0].port}</span>
            <span>+{servers.length - 1}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          <DropdownMenuLabel>{machine === "mac" ? "Running locally" : "Running on boat"}</DropdownMenuLabel>
          {servers.map((s) => (
            <DropdownMenuItem key={s.port} onSelect={() => open(s)}>
              <Live />
              <span className="font-mono">localhost:{s.port}</span>
              <span className="ml-auto pl-4 text-muted-foreground">{s.process}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

// B: a strip above the composer, the handoff row's place

const B: Slots = {
  strip: (servers, machine, open) =>
    servers.length > 0 && (
      <div className="flex items-center gap-1.5 pb-2">
        {machine === "boat" && (
          <span className="flex items-center gap-1 pr-1 text-ui text-muted-foreground">
            <Server className="size-3.5" />
            boat
          </span>
        )}
        {servers.map((s) => (
          <Tooltip key={s.port}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => open(s)}
                className="flex h-7 items-center gap-1.5 rounded-lg border border-border px-2 text-ui hover:bg-foreground/5"
              >
                <Live />
                <span className="font-mono">localhost:{s.port}</span>
                <span className="text-muted-foreground">{s.process}</span>
                <ArrowUpRight className="size-3.5 text-muted-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <ServerTip s={s} machine={machine} />
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    ),
};

// C: a card in the transcript, under the call that started it

const C: Slots = {
  card: (s, machine, open, isOpen) => (
    <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card py-1.5 pr-1.5 pl-3">
      <Live />
      <div className="flex min-w-0 flex-col">
        <span className="font-mono">localhost:{s.port}</span>
        <span className="text-muted-foreground">
          {s.process} · {machine === "mac" ? "running" : `running on boat, here as :${s.forwarded}`}
        </span>
      </div>
      <Button variant={isOpen ? "outline" : "default"} size="sm" className="ml-auto" onClick={() => open(s)}>
        {isOpen ? "Show tab" : "Open"}
      </Button>
    </div>
  ),
};

// D: a mark on the row — the sidebar for a session, Tasks for a bot

function RowMark({ servers, onOpen }: { servers: Srv[]; onOpen: (s: Srv) => void }) {
  if (servers.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(servers[0]);
          }}
          className="ml-auto flex h-5 shrink-0 items-center gap-1 rounded-md px-1 font-mono text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <Live />:{servers[0].port}
          {servers.length > 1 && <span className="font-sans">+{servers.length - 1}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {servers.map((s) => (
          <div key={s.port}>
            <span className="font-mono">localhost:{s.port}</span> · {s.process}
          </div>
        ))}
        <div className="opacity-70">Click opens {servers[0].port} in a tab</div>
      </TooltipContent>
    </Tooltip>
  );
}

const D: Slots = {
  sessionSide: (servers, _machine, open) => (
    <div className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border p-2 text-ui">
      <div className="px-2 pt-1 pb-1.5 text-muted-foreground">acme/site</div>
      {[
        { title: "Fix the pricing page", mine: true },
        { title: "Bump the Shiki version", mine: false },
        { title: "Write the release notes", mine: false },
      ].map((r) => (
        <div key={r.title} className={cn("flex h-7 items-center gap-1 rounded-md px-2", r.mine && "bg-foreground/8")}>
          <span className="truncate">{r.title}</span>
          {r.mine && <RowMark servers={servers} onOpen={open} />}
        </div>
      ))}
    </div>
  ),
  botSide: (tasks, lit, open) => (
    <div className="flex w-52 shrink-0 flex-col gap-0.5 border-l border-border p-2 text-ui">
      <div className="px-2 pt-1 pb-1.5 text-muted-foreground">Tasks</div>
      {tasks.map((t) => (
        <div key={t.id} className={cn("flex h-7 items-center gap-1.5 rounded-md px-2", t.id === lit && "bg-foreground/8")}>
          {face(t.id)}
          <span className="truncate">{t.title}</span>
          {t.machine === "boat" && <Server className="size-3 shrink-0 text-muted-foreground" />}
          <RowMark servers={t.servers} onOpen={(s) => open(s, t)} />
        </div>
      ))}
    </div>
  ),
};

// E: the + at the row's end lists them first

const E: Slots = {
  plus: (servers, machine, open, heading) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add a tab"
          className="relative flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 aria-expanded:bg-muted"
        >
          <Plus className="size-3.5" />
          {servers.length > 0 && <Live className="absolute top-1 right-1" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-64">
        {servers.length > 0 && (
          <>
            <DropdownMenuLabel className="text-muted-foreground">{heading}</DropdownMenuLabel>
            {servers.map((s) => (
              <DropdownMenuItem key={s.port} onSelect={() => open(s)}>
                <Live className="mx-[5px]" />
                <span className="font-mono">localhost:{s.port}</span>
                <span className="ml-auto pl-4 text-muted-foreground">
                  {s.process}
                  {machine === "boat" && ` · :${s.forwarded} here`}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem>
          <GlobeFilledIcon className={MARK} />
          Browser
          <Kbd className="ml-auto">⌘T</Kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

const VARIATIONS: { key: string; name: string; slots: Slots; pitch: string; trade: string }[] = [
  {
    key: "A",
    name: "Titlebar chip",
    slots: A,
    pitch: "A live dot and the port at the row's far end, beside the machine and branch. One server opens on click; two or more open a menu.",
    trade: "Always in view and costs no height. Small, and the far end is already crowded by machine, branch and PR.",
  },
  {
    key: "B",
    name: "Strip above the composer",
    slots: B,
    pitch: "One pill per server where the handoff row sits, full address and process named. Click opens a tab.",
    trade: "Readable and obvious. Takes a row of height, and competes with the handoff buttons for that spot.",
  },
  {
    key: "C",
    name: "Card in the transcript",
    slots: C,
    pitch: "A card under the tool call that started the server, live while it listens. Open, then Show tab once it is open.",
    trade: "Ties the server to what started it. Scrolls away in a long chat, and a server started by hand in the tree has no call to sit under.",
  },
  {
    key: "D",
    name: "Mark on the row",
    slots: D,
    pitch: "A port mark on the session's sidebar row, and on each task's row in the bot's Tasks list. Click opens the first; hover lists all.",
    trade: "One glance shows which tasks have something running — best for a bot with many tasks. Needs a poll per row, not just the lit one.",
  },
  {
    key: "E",
    name: "In the + menu",
    slots: E,
    pitch: "The + at the end of the tab row lists the lit session's servers above Browser, with a dot on the + while any run.",
    trade: "No new surface; opening a tab is where the reader already goes. Least discoverable: a dot is the only hint.",
  },
];

function Demo() {
  const [machine, setMachine] = useState<Machine>("boat");
  const [count, setCount] = useState<"one" | "two">("one");
  const servers = count === "two" ? MAIN : MAIN.slice(0, 1);
  const tasks = tasksFor(count === "two");
  // Keyed on the toggles, so a switch starts every window afresh.
  const reset = `${machine}-${count}`;
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-10 p-10 pb-40">
        <div className="flex flex-col gap-3">
          <h1 className="text-lg font-medium">A task's local servers, and opening one in a tab</h1>
          <p className="max-w-3xl text-ui text-muted-foreground">
            Five places to show what a session is serving. Left: a normal session. Right: a bot's row with a task lit —
            click the other task tab to switch; <b>Audit the landing page</b> runs on the <b>boat</b> sandbox. Opening a
            server adds a page tab to the row. On a remote machine the tab is this Mac's forward of the port.
          </p>
          <div className="flex items-center gap-4 text-ui">
            <span className="flex items-center gap-2">
              Session runs on
              <Segmented
                label="Session runs on"
                value={machine}
                onPick={setMachine}
                options={[
                  { value: "mac", label: where("mac") },
                  { value: "boat", label: "boat sandbox" },
                ]}
              />
            </span>
            <span className="flex items-center gap-2">
              Servers
              <Segmented
                label="Servers"
                value={count}
                onPick={setCount}
                options={[
                  { value: "one", label: "One" },
                  { value: "two", label: "Two" },
                ]}
              />
            </span>
          </div>
        </div>
        {VARIATIONS.map((v) => (
          <section key={v.key} id={v.key} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="font-medium">
                {v.key} — {v.name}
              </h2>
              <p className="max-w-3xl text-ui">{v.pitch}</p>
              <p className="max-w-3xl text-ui text-muted-foreground">{v.trade}</p>
            </div>
            <div className="flex flex-wrap gap-6" key={reset}>
              <SessionWindow slots={v.slots} machine={machine} servers={servers} />
              <BotWindow slots={v.slots} tasks={tasks} />
            </div>
          </section>
        ))}
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
