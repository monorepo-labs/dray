import { ChatBubbleOvalLeftIcon, DocumentPlusIcon } from "@heroicons/react/16/solid";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Clock,
  Folder,
  ExternalLink,
  Globe,
  RotateCw,
  Server,
  Share2,
  SquareDashedMousePointer,
  Unplug,
} from "lucide-react";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import BotAvatar from "@/components/BotAvatar";
import GlobeFilledIcon from "@/components/icons/GlobeFilledIcon";
import { ItemTab } from "@/components/layout/ViewTabs";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { seededAvatar } from "@/lib/botAvatar";
import { cn } from "@/lib/utils";
import "../App.css";

/// Five takes on a session's dev servers *inside* the browser view — the new
/// tab, the URL bar, the toolbar, a dead page — now that a bot task's links
/// open as tabs in the bot's own browser. Each is drawn for a normal session
/// on boat and for a bot, whose browser gathers every task's servers.

type Task = { id: string; title: string; machine?: string };
/// `forwarded` is this Mac's port for a server on another machine, what the tab really loads.
type Srv = { port: number; process: string; page: string; task?: Task; forwarded?: number };

const FIX: Task = { id: "fix", title: "Fix the pricing page" };
const AUDIT: Task = { id: "audit", title: "Audit the landing page", machine: "boat" };
const DOCS: Task = { id: "docs", title: "Add docs search", machine: "cloud-7f3a" };

const SESSION: Srv[] = [
  { port: 3000, process: "next-server", page: "Pricing — Acme", forwarded: 52011 },
  { port: 6006, process: "storybook", page: "Storybook", forwarded: 52014 },
];
const BOT: Srv[] = [
  { port: 3000, process: "next-server", page: "Pricing — Acme", task: FIX },
  { port: 6006, process: "storybook", page: "Storybook", task: FIX },
  { port: 5173, process: "vite", page: "Acme — Ship faster", task: AUDIT, forwarded: 52020 },
  { port: 4321, process: "astro", page: "Docs — Acme", task: DOCS, forwarded: 52023 },
];
const RECENT = [
  { url: "github.com/acme/site/pull/954", title: "Fix pricing cards #954" },
  { url: "vercel.com/acme/site", title: "acme/site — Vercel" },
];

const MARK = "size-4 shrink-0 text-muted-foreground";
const TOOL_BTN = "hover:bg-foreground/10 aria-expanded:bg-foreground/10";

const face = (t: Task, className = "size-4") => (
  <BotAvatar seed={`task-${t.id}`} avatar={seededAvatar(`task-${t.id}`)} className={cn("block shrink-0 scale-[1.18]", className)} />
);

function Live({ className, off }: { className?: string; off?: boolean }) {
  if (off) return <span className={cn("size-1.5 shrink-0 rounded-full bg-muted-foreground/50", className)} />;
  return (
    <span className={cn("relative flex size-1.5 shrink-0", className)}>
      <span className="absolute inset-0 animate-ping rounded-full bg-accent-add opacity-50 [animation-duration:2s]" />
      <span className="relative size-1.5 rounded-full bg-accent-add" />
    </span>
  );
}

function MachineMark({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      <Server className="size-3" />
      {name}
    </span>
  );
}

/// The session's own machine for a normal session; the task's for a bot.
const machineOf = (s: Srv, sessionMachine?: string) => (s.task ? s.task.machine : sessionMachine);

// The window: the titlebar row, the browser's toolbar, the page.

/// `full` draws the window at the page's size, as the app's browser view is.
type Win = { bot: boolean; servers: Srv[]; machine?: string; full?: boolean };
const WINDOWS: Win[] = [
  { bot: false, servers: SESSION, machine: "boat" },
  { bot: true, servers: BOT },
];

function Row({ bot, label, page }: { bot: boolean; label: string; page: boolean }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 bg-surface-frame px-2">
      {bot ? (
        <>
          <ItemTab icon={<ChatBubbleOvalLeftIcon className={MARK} />} label="Dray" active={false} onPick={() => {}} fixed />
          <ItemTab icon={face(FIX)} label={FIX.title} active={false} onPick={() => {}} onClose={() => {}} />
          <ItemTab icon={face(AUDIT)} label={AUDIT.title} active={false} onPick={() => {}} onClose={() => {}} machine="boat" />
        </>
      ) : (
        <ItemTab icon={<ChatBubbleOvalLeftIcon className={MARK} />} label="Fix the pricing page" active={false} onPick={() => {}} />
      )}
      <ItemTab
        icon={page ? <GlobeFilledIcon className={MARK} /> : <Globe className="size-3.5 shrink-0 text-muted-foreground" />}
        label={label}
        active
        onPick={() => {}}
        onClose={() => {}}
      />
      {!bot && (
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-ui text-muted-foreground">
          <Server className="size-3.5" />
          boat
        </span>
      )}
    </div>
  );
}

function Toolbar({
  value,
  page,
  focused,
  chip,
  under,
  right,
}: {
  value: string;
  page: boolean;
  focused?: boolean;
  chip?: React.ReactNode;
  under?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className={cn("relative z-10 flex h-9 shrink-0 items-center gap-0.5 border-b border-foreground/10 px-1.5", page && "bg-card")}>
      {[ArrowLeft, ArrowRight, RotateCw].map((Icon, i) => (
        <Button key={i} variant="ghost" size="icon-sm" className={TOOL_BTN} disabled={!page && i < 2}>
          <Icon className="size-3.5" />
        </Button>
      ))}
      <div className="relative min-w-0 flex-1">
        <div
          className={cn(
            "flex h-7 w-full items-center gap-1.5 rounded-md px-2.5 font-mono text-ui",
            page ? "bg-transparent" : "bg-surface-raised dark:bg-background",
            focused && "bg-foreground/10 ring-1 ring-ring/40",
          )}
        >
          {chip}
          {value ? <span className="truncate">{value}</span> : <span className="text-muted-foreground">Search or enter a URL</span>}
          {focused && <span className="-ml-1 h-4 w-px animate-pulse bg-foreground" />}
        </div>
        {under}
      </div>
      {right}
      {[SquareDashedMousePointer, Bug, ExternalLink].map((Icon, i) => (
        <Button key={i} variant="ghost" size="icon-sm" className={TOOL_BTN} disabled={!page}>
          <Icon className="size-3.5" />
        </Button>
      ))}
    </div>
  );
}

function FakePage({ srv }: { srv: Srv }) {
  return (
    <div className="flex flex-1 flex-col gap-3 bg-white p-6 text-neutral-900">
      <div className="flex items-center justify-between">
        <span className="font-bold">Acme</span>
        <span className="text-sm text-neutral-500">Pricing · Docs · Sign in</span>
      </div>
      <h2 className="text-xl font-semibold">{srv.page}</h2>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-neutral-100" />
        ))}
      </div>
    </div>
  );
}

/// A server's page open in the tab, or the new tab's own content.
function Frame({
  win,
  page,
  toolbar,
  empty,
  label,
}: {
  win: Win;
  page: Srv | null;
  toolbar: React.ReactNode;
  empty: React.ReactNode;
  /// The tab's name where the empty content is a page of its own, not a new tab.
  label?: string;
}) {
  return (
    <div
      style={win.full ? { height: "100%", width: "100%" } : { height: 480, width: 640 }}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-card"
    >
      <Row bot={win.bot} label={page ? page.page : (label ?? "New tab")} page={!!page || !!label} />
      {toolbar}
      {page ? <FakePage srv={page} /> : <div className="relative min-h-0 flex-1 overflow-hidden">{empty}</div>}
    </div>
  );
}

function Recent() {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-2 pb-1 text-muted-foreground">Recently visited</h3>
      {RECENT.map((r) => (
        <div key={r.url} className="flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-foreground/5">
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{r.title}</span>
          <span className="ml-auto min-w-0 max-w-1/2 shrink-0 truncate font-mono text-muted-foreground">{r.url}</span>
        </div>
      ))}
    </section>
  );
}

/// The servers grouped under the task that runs them; a normal session has
/// one group, its own, headed by its machine as today.
function groups(win: Win): { task?: Task; heading: React.ReactNode; servers: Srv[] }[] {
  if (!win.bot) {
    return [{ heading: win.machine ? `Running on ${win.machine}` : "Running locally", servers: win.servers }];
  }
  const tasks = [...new Set(win.servers.map((s) => s.task!))];
  return tasks.map((t) => ({
    task: t,
    heading: (
      <span className="flex min-w-0 items-center gap-1.5">
        {face(t)}
        <span className="truncate text-foreground">{t.title}</span>
        <span className="ml-auto pl-2">
          <MachineMark name={t.machine} />
        </span>
      </span>
    ),
    servers: win.servers.filter((s) => s.task === t),
  }));
}

/// A's list, in the markup `Servers` in BrowserPane draws: a heading per
/// task (or the session's machine), a bordered card per server.
function ServerList({ win, onOpen }: { win: Win; onOpen: (s: Srv) => void }) {
  return (
    <>
      {groups(win).map((g, i) => (
        <section key={i} className="flex flex-col gap-1.5">
          <h3 className="px-2 pb-1 text-muted-foreground">{g.heading}</h3>
          {g.servers.map((s) => (
            <div key={s.port} className="flex flex-col rounded-lg border border-border">
              <div className="flex min-h-9 items-center gap-1 p-1">
                <button
                  type="button"
                  onClick={() => onOpen(s)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left hover:underline"
                >
                  <span className="font-mono">localhost:{s.port}</span>
                  <span className="truncate text-muted-foreground">{s.process}</span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Get shareable link"
                  className={cn("group/share h-7 shrink-0 gap-0 px-[7px] text-ui text-muted-foreground", TOOL_BTN)}
                >
                  <Share2 className="size-3.5" />
                  <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 ease-out group-hover/share:max-w-40 group-hover/share:opacity-100 motion-reduce:transition-none">
                    <span className="block pr-0.5 pl-1.5">Get shareable link</span>
                  </span>
                </Button>
              </div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

/// The Diff and Files cards the new tab leads with once a turn has run.
function TurnCards() {
  return (
    <section className="grid grid-cols-2 gap-2">
      {[
        { label: "Diff", icon: <DocumentPlusIcon className="size-4 text-muted-foreground" /> },
        { label: "Files", icon: <Folder className="size-4 fill-current text-muted-foreground" /> },
      ].map((c) => (
        <button
          key={c.label}
          type="button"
          className="flex flex-col items-start gap-1.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-foreground/5"
        >
          <span className="flex size-4 items-center justify-center">{c.icon}</span>
          {c.label}
        </button>
      ))}
    </section>
  );
}

// A: today's new-tab list, grouped by task in a bot's browser.

function A({ win }: { win: Win }) {
  const [page, setPage] = useState<Srv | null>(null);
  return (
    <Frame
      win={win}
      page={page}
      toolbar={<Toolbar value={page ? `localhost:${page.forwarded ?? page.port}` : ""} page={!!page} />}
      empty={
        <div className="flex h-full overflow-y-auto p-8 text-ui">
          <div className="m-auto flex w-full max-w-sm flex-col gap-4">
            <TurnCards />
            <ServerList win={win} onOpen={setPage} />
            {!win.bot && <Recent />}
            <p className="px-2 text-muted-foreground">Search or enter a URL above, or open a link from the chat.</p>
          </div>
        </div>
      }
    />
  );
}

// B: tiles, a browser start page.

function B({ win }: { win: Win }) {
  const [page, setPage] = useState<Srv | null>(null);
  return (
    <Frame
      win={win}
      page={page}
      toolbar={<Toolbar value={page ? `localhost:${page.port}` : ""} page={!!page} />}
      empty={
        <div className="flex h-full flex-col gap-4 px-6 pt-5 text-ui">
          <h3 className="text-muted-foreground">{win.bot ? "Running in Dray's tasks" : `Running on ${win.machine}`}</h3>
          <div className="grid grid-cols-2 gap-3">
            {win.servers.map((s) => (
              <button
                key={s.task?.id + String(s.port)}
                type="button"
                onClick={() => setPage(s)}
                className="flex flex-col overflow-hidden rounded-xl border border-border text-left transition-colors hover:border-foreground/25"
              >
                <div className="flex h-14 flex-col gap-1 bg-white px-3 py-2 text-neutral-900">
                  <span className="truncate text-xs font-semibold">{s.page}</span>
                  <span className="flex gap-1">
                    <span className="h-5 flex-1 rounded bg-neutral-100" />
                    <span className="h-5 flex-1 rounded bg-neutral-100" />
                    <span className="h-5 flex-1 rounded bg-neutral-100" />
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-1.5 border-t border-border px-2.5 py-1.5">
                  <Live />
                  <span className="font-mono">:{s.port}</span>
                  <span className="truncate text-muted-foreground">{s.process}</span>
                  <span className="ml-auto flex min-w-0 items-center gap-1">
                    {s.task && face(s.task, "size-3.5")}
                    <MachineMark name={machineOf(s, win.machine)} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      }
    />
  );
}

// C: the URL bar's suggestions lead with what is running.

function C({ win }: { win: Win }) {
  const [page, setPage] = useState<Srv | null>(null);
  const [open, setOpen] = useState(true);
  const list = (
    <ul className="absolute inset-x-0 top-full mt-1 overflow-hidden rounded-lg bg-popover p-1 text-ui text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-xl">
      <li className="px-2 pt-1 pb-0.5 text-muted-foreground">Running</li>
      {win.servers.map((s, i) => (
        <li
          key={s.task?.id + String(s.port)}
          onMouseDown={() => {
            setPage(s);
            setOpen(false);
          }}
          className={cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1", i === 0 && "bg-accent text-accent-foreground")}
        >
          <Live className="mx-[5px]" />
          <span className="shrink-0 font-mono">localhost:{s.port}</span>
          <span className="min-w-0 truncate text-muted-foreground">{s.task ? s.task.title : s.page}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-muted-foreground">
            {s.task && face(s.task, "size-3.5")}
            <MachineMark name={machineOf(s, win.machine)} />
          </span>
        </li>
      ))}
      <li className="mt-1 border-t border-border px-2 pt-1.5 pb-0.5 text-muted-foreground">Recent</li>
      {RECENT.map((r) => (
        <li key={r.url} className="flex items-center gap-2 rounded-md px-2 py-1">
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-mono">{r.url}</span>
          <span className="min-w-0 truncate text-muted-foreground">{r.title}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <Frame
      win={win}
      page={page}
      toolbar={<Toolbar value={page ? `localhost:${page.port}` : ""} page={!!page} focused={open && !page} under={open && !page && list} />}
      empty={
        <button type="button" className="flex h-full w-full items-end justify-center pb-6 text-ui text-muted-foreground" onClick={() => setOpen((o) => !o)}>
          {open ? "Opens as the field takes focus — ⌘T lands here" : "Click to focus the URL bar"}
        </button>
      }
    />
  );
}

// D: a toolbar button on every page, and the URL bar naming whose server it is.

function D({ win }: { win: Win }) {
  const [page, setPage] = useState<Srv | null>(win.bot ? BOT[2] : SESSION[0]);
  const [open, setOpen] = useState(true);
  const owner = page && (page.task ?? null);
  const machine = page ? machineOf(page, win.machine) : undefined;
  const chip = page && (owner || machine) && (
    <span className="flex shrink-0 items-center gap-1 rounded-md bg-foreground/8 px-1.5 py-0.5 font-sans text-muted-foreground">
      {owner && face(owner, "size-3.5")}
      {owner && <span className="max-w-32 truncate text-foreground">{owner.title}</span>}
      <MachineMark name={machine} />
    </span>
  );
  const button = (
    <div className="relative">
      <Button variant="ghost" size="sm" className={cn("h-7 gap-1.5 px-2", TOOL_BTN)} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Live />
        <span className="font-mono text-ui">{win.servers.length}</span>
      </Button>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 w-80 rounded-lg bg-popover p-1 text-ui text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-xl">
          {groups(win).map((g, i) => (
            <div key={i} className="flex flex-col">
              <div className="px-2 pt-1.5 pb-0.5 text-muted-foreground">{g.heading}</div>
              {g.servers.map((s) => (
                <button
                  key={s.port}
                  type="button"
                  onClick={() => {
                    setPage(s);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent",
                    s === page && "bg-accent text-accent-foreground",
                  )}
                >
                  <Live className="mx-[5px]" />
                  <span className="font-mono">localhost:{s.port}</span>
                  <span className="ml-auto text-muted-foreground">{s === page ? "this tab" : s.process}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <Frame
      win={win}
      page={page}
      toolbar={<Toolbar value={page ? `localhost:${page.port}/` : ""} page={!!page} chip={chip} right={button} />}
      empty={null}
    />
  );
}

// E: the page a stopped server leaves, naming who ran it and what else runs.

function E({ win }: { win: Win }) {
  const dead = win.servers[0];
  const [page, setPage] = useState<Srv | null>(null);
  const rest = win.servers.slice(1);
  return (
    <Frame
      win={win}
      page={page}
      label={`localhost:${dead.port}`}
      toolbar={<Toolbar value={`localhost:${page?.port ?? dead.port}/`} page />}
      empty={
        <div className="flex h-full overflow-y-auto bg-card p-8 text-ui">
          <div className="m-auto flex w-full flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-2 text-center">
            <Unplug className="size-6 text-muted-foreground" />
            <h2 className="text-base font-medium">Nothing is answering on localhost:{dead.port}</h2>
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-muted-foreground">
              {dead.task && (
                <span className="flex items-center gap-1.5 text-foreground">
                  {face(dead.task, "size-3.5")}
                  {dead.task.title}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Server className="size-3.5" />
                {machineOf(dead, win.machine) ?? "This Mac"}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" />
                stopped 2 min ago
              </span>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm">{dead.task ? "Ask the task to restart it" : "Ask the agent to restart it"}</Button>
              <Button size="sm" variant="outline" className={TOOL_BTN}>
                Retry
              </Button>
            </div>
          </div>
          {rest.length > 0 && (
            <div className="mt-12 flex w-full max-w-sm flex-col gap-4">
              <ServerList win={{ ...win, servers: rest }} onOpen={setPage} />
            </div>
          )}
          </div>
        </div>
      }
    />
  );
}

const VARIATIONS: { key: string; name: string; View: (p: { win: Win }) => React.ReactNode; pitch: string; trade: string }[] = [
  {
    key: "A",
    name: "New tab, grouped by task",
    View: A,
    pitch: "Today's Running list, kept. In a bot's browser it gathers every task's servers under the task's face, title and machine.",
    trade: "Least new to learn, and the bot's new tab finally shows its tasks' servers. Only on a new tab; a long bot fills the page with headings.",
  },
  {
    key: "B",
    name: "New tab as tiles",
    View: B,
    pitch: "A start page: a tile per server with its page title, port, process, and the task's face and machine in the corner.",
    trade: "Reads at a glance, and the page title says which app it is better than a port does. Needs the title fetched; tall with many servers.",
  },
  {
    key: "C",
    name: "In the URL bar's suggestions",
    View: C,
    pitch: "Focus the URL bar (⌘T does) and running servers lead the list, ahead of history; typing a port or task name filters both.",
    trade: "Works from any tab, not just a new one, and costs no space. Hidden until the field is focused.",
  },
  {
    key: "D",
    name: "Toolbar button, and whose server this is",
    View: D,
    pitch: "A dot and count in the toolbar on every page opens the list grouped by task. On a server's page the URL bar names its task and machine, and shows the real port, not the forward.",
    trade: "Always one click away, and a forwarded localhost:52020 stops being a mystery. One more toolbar button.",
  },
  {
    key: "E",
    name: "The page a stopped server leaves",
    View: E,
    pitch: "When the server behind a tab stops, the page says who ran it and offers to ask that task to restart it, then lists what still runs.",
    trade: "Catches the most common dead end — a tab left on a server that went away. Complements the others rather than replacing them.",
  },
];

/// `?full=A&who=bot` draws one take alone at the window's size, behind a
/// sidebar-wide strip, so its spacing reads as it would in the app.
function Full({ view, bot }: { view: string; bot: boolean }) {
  const v = VARIATIONS.find((x) => x.key === view) ?? VARIATIONS[0];
  const win = { ...WINDOWS[bot ? 1 : 0], full: true };
  return (
    <TooltipProvider>
      <div className="flex h-screen">
        <aside className="flex w-60 shrink-0 flex-col gap-2 p-4 text-ui text-muted-foreground">
          <a href="?" className="hover:text-foreground">
            ← All variations
          </a>
          <span>
            {v.key} — {v.name}, {bot ? "bot" : "session"}
          </span>
          <FullLinks />
        </aside>
        <main className="min-w-0 flex-1 p-2 pl-0">
          <v.View win={win} />
        </main>
      </div>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

function FullLinks() {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-ui">
      {["A", "E"].flatMap((k) =>
        ["session", "bot"].map((who) => (
          <a key={k + who} href={`?full=${k}&who=${who}`} className="underline underline-offset-2 hover:text-foreground">
            {k} {who}
          </a>
        )),
      )}
    </span>
  );
}

function Demo() {
  const params = new URLSearchParams(location.search);
  const full = params.get("full");
  if (full) return <Full view={full} bot={params.get("who") === "bot"} />;
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-10 p-10 pb-40">
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-medium">Dev servers inside the browser</h1>
          <p className="max-w-3xl text-ui text-muted-foreground">
            Left: a normal session on <b>boat</b>, two servers. Right: a bot's browser, where every task's links now open — its
            servers come from three tasks on This Mac, boat and a cloud machine. Click a server to open it in the tab.
          </p>
          <p className="flex items-center gap-2 text-ui text-muted-foreground">
            Full page, at the window's size: <FullLinks />
          </p>
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
            <div className="flex flex-wrap gap-6">
              {WINDOWS.map((w) => (
                <v.View key={String(w.bot)} win={w} />
              ))}
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
