import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, ChevronDown, Play } from "lucide-react";

import BotAvatar from "@/components/BotAvatar";
import { StartBox } from "@/components/PullDetail";
import ProjectSelector from "@/components/composer/ProjectSelector";
import WorktreeToggle from "@/components/composer/WorktreeToggle";
import TaskChip from "@/components/TaskChip";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Spinner from "@/components/ui/spinner";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { issueRepo, lastTaskPicks, type IssuePicks } from "@/lib/issueStart";
import type { PrMachines } from "@/lib/prInbox";
import { LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Bot, IssueRef, Project, SessionIndexItem } from "@/types/events";

/// What the issues page needs from `App` to start work on an issue in place.
export type IssueStarter = {
  /// Where a GitHub issue's task can run, clone stand-ins included; null for
  /// a Linear issue, whose project the reader picks.
  machinesFor: (issue: IssueRef) => PrMachines | null;
  /// Every attached project, for a Linear issue's picker.
  projects: Project[];
  onAttached: (server: ServerId, list: Project[]) => void;
  bots: Bot[];
  /// Starts a task for the issue, its tag, link and body the prompt with
  /// `note` last, in `where`, or the issue's own checkout, cloned if need be.
  start: (
    issue: IssueRef,
    note?: string,
    picks?: IssuePicks,
    where?: string | null,
    onCloning?: (line: string | null) => void,
  ) => Promise<void>;
  send: (issue: IssueRef, bot: Bot, note?: string) => Promise<void>;
  /// Tasks linked to the issue, newest first, for its row's chip.
  tasksFor: (issue: IssueRef) => SessionIndexItem[];
  botOf: (item: SessionIndexItem) => Bot | undefined;
  onOpenTask: (item: SessionIndexItem) => void;
};

export const IssueStartContext = createContext<IssueStarter | null>(null);

type Act = { state: "idle" } | { state: "busy" } | { state: "done"; said: string } | { state: "failed"; said: string };

/// One action's progress: a spinner while it runs, its outcome for a few
/// seconds after.
function useAct() {
  const [act, setAct] = useState<Act>({ state: "idle" });
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = async (work: () => Promise<void>, done: string) => {
    window.clearTimeout(timer.current);
    setAct({ state: "busy" });
    try {
      await work();
      setAct({ state: "done", said: done });
      timer.current = window.setTimeout(() => setAct({ state: "idle" }), 2500);
    } catch (e) {
      setAct({ state: "failed", said: e instanceof Error ? e.message : String(e) });
      timer.current = window.setTimeout(() => setAct({ state: "idle" }), 6000);
    }
  };
  return [act, run] as const;
}

/// Start task and Send to bot on a list row's hover. Spans, since the row is
/// itself a `role="button"` and a real button inside it is invalid nesting.
export function IssueQuickActions({ issue }: { issue: IssueRef }) {
  const ctx = useContext(IssueStartContext);
  const [startAct, runStart] = useAct();
  const [sendAct, runSend] = useAct();
  if (!ctx) return null;
  const machines = ctx.machinesFor(issue);
  const cloning = !!machines && machines.clones.includes(machines.initial);
  const send = (bot: Bot) => void runSend(() => ctx.send(issue, bot), `Sent to ${bot.name}`);
  const startHint = !machines
    ? "Open the issue to pick a project"
    : cloning
      ? `Clone ${issueRepo(issue)} into ~/dray and start a task`
      : "Start a task on your last settings";

  return (
    <span className={cn("flex shrink-0 items-center gap-1", (startAct.state !== "idle" || sendAct.state !== "idle") && "row-busy")}>
      <ActButton
        act={startAct}
        disabled={!machines}
        hint={startHint}
        onPress={() => void runStart(() => ctx.start(issue), "Started")}
        icon={<Play />}
      >
        Start task
      </ActButton>
      <SendToBot bots={ctx.bots} act={sendAct} onSend={send} variant="ghost" />
    </span>
  );
}

/// One row action. Its label gives way to the outcome while one is showing.
function ActButton({
  act,
  disabled,
  hint,
  onPress,
  icon,
  menu,
  variant = "ghost",
  className,
  children,
  ...trigger
}: {
  act: Act;
  variant?: "ghost" | "secondary";
  disabled?: boolean;
  hint: string;
  onPress?: () => void;
  icon?: ReactNode;
  /// A menu trigger: Radix drives the press through the spread props.
  menu?: boolean;
  children: ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const press = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (disabled || act.state === "busy") return;
    onPress?.();
  };
  const label =
    act.state === "busy" ? (
      <>
        <Spinner className="size-3" />
        {children}
      </>
    ) : act.state === "done" ? (
      <>
        <Check className="text-accent-add" />
        {act.said}
      </>
    ) : (
      <>
        {icon}
        {children}
        {menu && <ChevronDown data-icon="inline-end" className="opacity-60" />}
      </>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          {...trigger}
          aria-disabled={disabled || undefined}
          className={cn(
            buttonVariants({ variant, size: "xs" }),
            disabled && "cursor-default opacity-50 hover:bg-transparent",
            act.state === "failed" && "text-destructive",
            className,
          )}
          onClick={(e) => {
            if (!menu) return press(e);
            e.stopPropagation();
            trigger.onClick?.(e);
          }}
          onKeyDown={(e) => {
            if (menu) {
              e.stopPropagation();
              trigger.onKeyDown?.(e);
              return;
            }
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            press(e);
          }}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{act.state === "failed" ? act.said : hint}</TooltipContent>
    </Tooltip>
  );
}

const LAST_BOT_KEY = "dray.issueSendBot";
let lastBotId = readLocalStorage<string | null>(LAST_BOT_KEY, null);
const lastBotListeners = new Set<() => void>();

/// The bot Send to bot names, the last one anything here was sent to; shared
/// by the rows and the pane, so a pick in one moves the other.
function useLastBot(bots: Bot[]): [Bot | null, (id: string) => void] {
  const id = useSyncExternalStore(
    (l) => {
      lastBotListeners.add(l);
      return () => lastBotListeners.delete(l);
    },
    () => lastBotId,
  );
  const set = (next: string) => {
    lastBotId = next;
    writeLocalStorage(LAST_BOT_KEY, next);
    for (const l of lastBotListeners) l();
  };
  return [bots.find((b) => b.id === id) ?? bots[0] ?? null, set];
}

/// Send to bot as a split button: the face names the last bot used and sends
/// to it; the chevron lists the others, and a pick there sends at once and
/// becomes the new last.
function SendToBot({
  bots,
  act,
  onSend,
  variant,
}: {
  bots: Bot[];
  act: Act;
  onSend: (bot: Bot) => void;
  variant: "ghost" | "secondary";
}) {
  const [last, setLast] = useLastBot(bots);
  if (!last) return null;
  const others = bots.filter((b) => b.id !== last.id);
  const send = (bot: Bot) => {
    setLast(bot.id);
    onSend(bot);
  };
  return (
    <span className="flex shrink-0 items-center gap-px">
      <ActButton
        act={act}
        variant={variant}
        hint={`Send it to ${last.name}, who starts it when free`}
        onPress={() => send(last)}
        icon={<BotAvatar seed={last.id} avatar={last.avatar} className="block size-3.5 scale-[1.18]" />}
        className={cn("max-w-44", others.length > 0 && "rounded-r-none")}
      >
        <span className="truncate">Send to {last.name}</span>
      </ActButton>
      {others.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <ActButton act={{ state: "idle" }} variant={variant} hint="Send to another bot" menu className="rounded-l-none px-1">
              {null}
            </ActButton>
          </DropdownMenuTrigger>
          {/* React events bubble through the portal to the row, which would
              open the issue under the pick. */}
          <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Send to</DropdownMenuLabel>
            {others.map((bot) => (
              <DropdownMenuItem key={bot.id} onSelect={() => send(bot)}>
                <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-4 scale-[1.18]" />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

/// The details pane's foot: the pull requests page's own start box, its
/// Bot | Task switch included. The box holds only the reader's note; the
/// issue itself rides along unseen. Keyed per issue by its caller.
export function IssueComposer({ issue }: { issue: IssueRef }) {
  const ctx = useContext(IssueStartContext);
  const [note, setNote] = useState("");
  const [picks, setPicks] = useState<IssuePicks>(lastTaskPicks);
  const [where, setWhere] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cloning, setCloning] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const [lastBot] = useLastBot(ctx?.bots ?? []);
  if (!ctx) return null;

  const machines = ctx.machinesFor(issue);
  const machine = machines ? (where && machines.projects.some((p) => p.path === where) ? where : machines.initial) : where;
  const server = machine ? serverOfPath(machine) : LOCAL;

  const start = async (bot: Bot | null) => {
    setStarting(true);
    setSaid(null);
    window.clearTimeout(timer.current);
    try {
      if (bot) await ctx.send(issue, bot, note);
      else await ctx.start(issue, note, picks, machine, setCloning);
      setNote("");
      setSaid({ text: bot ? `Sent to ${bot.name}.` : "Task started.", failed: false });
      timer.current = window.setTimeout(() => setSaid(null), 3000);
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : String(e), failed: true });
    } finally {
      setStarting(false);
      setCloning(null);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 px-3 pt-2 pb-3">
      <StartBox
        bots={ctx.bots}
        server={server}
        machines={machines?.projects ?? []}
        machine={machine ?? ""}
        onMachine={setWhere}
        picks={picks}
        onPicks={(next) => setPicks((prev) => ({ ...prev, ...next }))}
        onRepairPicks={(next) => setPicks((prev) => ({ ...prev, ...next }))}
        disabled={starting}
        taskDisabled={!machine}
        taskControls={
          <>
            {/* A Linear issue names no repository, so the reader picks one. */}
            {!machines && (
              <ProjectSelector projects={ctx.projects} value={where} onSelect={setWhere} onAttached={ctx.onAttached} />
            )}
            <WorktreeToggle on={picks.useWorktree} onToggle={() => setPicks((p) => ({ ...p, useWorktree: !p.useWorktree }))} />
          </>
        }
        botPick={lastBot}
        botAction={(send) => (
          <SendToBot
            bots={ctx.bots}
            act={starting ? { state: "busy" } : { state: "idle" }}
            onSend={send}
            variant="secondary"
          />
        )}
        starting={starting}
        cloning={cloning !== null}
        onStart={(bot) => void start(bot)}
      >
        {(go) => (
          <textarea
            rows={2}
            value={note}
            aria-label="Note for the agent"
            placeholder="Anything to add? The issue goes with it."
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                go();
              }
            }}
            className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-ui outline-none placeholder:text-muted-foreground field-sizing-content"
          />
        )}
      </StartBox>
      {cloning !== null && (
        <p className="truncate px-3 text-ui text-muted-foreground tabular-nums">
          Cloning {issueRepo(issue)}
          {cloning ? ` · ${cloning}` : "…"}
        </p>
      )}
      {said && <p className={cn("px-3 text-ui", said.failed ? "text-destructive" : "text-muted-foreground")}>{said.text}</p>}
    </div>
  );
}

/// A row's chip for the tasks linked to its issue.
export function IssueTaskChip({ issue, className }: { issue: IssueRef; className?: string }) {
  const ctx = useContext(IssueStartContext);
  if (!ctx) return null;
  return <TaskChip tasks={ctx.tasksFor(issue)} botOf={ctx.botOf} onOpen={ctx.onOpenTask} className={className} />;
}
