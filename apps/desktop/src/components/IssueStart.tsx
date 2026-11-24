import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, FolderGit2, Play } from "lucide-react";

import BotAvatar from "@/components/BotAvatar";
import { SessionLink, TaskModelPicker } from "@/components/PullDetail";
import SendButton from "@/components/composer/SendButton";
import WorktreeToggle from "@/components/composer/WorktreeToggle";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { issuePrompt, issueRepo, lastTaskPicks, type IssuePicks } from "@/lib/issueStart";
import { LOCAL, serverOfPath } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Bot, IssueDetail, IssueRef, Project, SessionIndexItem } from "@/types/events";

/// What the issues page needs from `App` to start work on an issue in place.
export type IssueStarter = {
  /// The checkout a task for the issue runs in, if one is attached.
  projectFor: (issue: IssueRef) => Project | undefined;
  /// Tasks filed under the issue, newest first.
  tasksFor: (issue: IssueRef) => SessionIndexItem[];
  bots: Bot[];
  botOf: (item: SessionIndexItem) => Bot | undefined;
  onOpenTask: (item: SessionIndexItem) => void;
  /// Starts a task for the issue. No prompt builds the issue's own, and no
  /// picks takes the last ones a new task started on.
  start: (issue: IssueRef, prompt?: string, picks?: IssuePicks) => Promise<void>;
  give: (issue: IssueRef, bot: Bot) => Promise<void>;
};

export const IssueStartContext = createContext<IssueStarter | null>(null);

/// What Start task says it cannot do where no project matches the issue.
function noProject(issue: IssueRef): string {
  const repo = issueRepo(issue);
  return repo ? `No project here has ${repo} as its remote` : "A Linear issue names no repository to work in";
}

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

/// Start task and Give to bot, on a list row's hover and in the details pane.
/// `inRow` draws them as spans, since the row is itself a `role="button"`
/// and a real button inside it is invalid nesting.
export function IssueQuickActions({ issue, inRow }: { issue: IssueRef; inRow?: boolean }) {
  const ctx = useContext(IssueStartContext);
  const [startAct, runStart] = useAct();
  const [giveAct, runGive] = useAct();
  if (!ctx) return null;
  const project = ctx.projectFor(issue);
  const give = (bot: Bot) => void runGive(() => ctx.give(issue, bot), `Given to ${bot.name}`);
  const startHint = project
    ? `Start a task in ${project.name} on your last settings`
    : noProject(issue);

  return (
    <span className={cn("flex shrink-0 items-center gap-1", inRow && (startAct.state !== "idle" || giveAct.state !== "idle") && "row-busy")}>
      <ActButton
        inRow={inRow}
        act={startAct}
        disabled={!project}
        hint={startHint}
        onPress={() => void runStart(() => ctx.start(issue), "Started")}
        icon={<Play />}
      >
        Start task
      </ActButton>
      {ctx.bots.length === 1 && (
        <ActButton
          inRow={inRow}
          act={giveAct}
          hint={`Hand it to ${ctx.bots[0].name}, who starts it when free`}
          onPress={() => give(ctx.bots[0])}
          icon={<BotAvatar seed={ctx.bots[0].id} avatar={ctx.bots[0].avatar} className="block size-3.5 scale-[1.18]" />}
        >
          Give to bot
        </ActButton>
      )}
      {ctx.bots.length > 1 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <ActButton inRow={inRow} act={giveAct} hint="Hand it to a bot, who starts it when free" menu>
              Give to bot
            </ActButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Give to</DropdownMenuLabel>
            {ctx.bots.map((bot) => (
              <DropdownMenuItem key={bot.id} onSelect={() => give(bot)}>
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

/// One action. Its label gives way to the outcome while one is showing.
function ActButton({
  inRow,
  act,
  disabled,
  hint,
  onPress,
  icon,
  menu,
  children,
  ...trigger
}: {
  inRow?: boolean;
  act: Act;
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
  const className = cn(
    buttonVariants({ variant: inRow ? "ghost" : "secondary", size: "xs" }),
    disabled && "cursor-default opacity-50 hover:bg-transparent",
    act.state === "failed" && "text-destructive",
  );
  const props = {
    ...trigger,
    "aria-disabled": disabled || undefined,
    className,
    onClick: menu
      ? (e: React.MouseEvent<HTMLElement>) => {
          e.stopPropagation();
          trigger.onClick?.(e);
        }
      : press,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (menu) {
        e.stopPropagation();
        trigger.onKeyDown?.(e);
        return;
      }
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      press(e);
    },
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {inRow ? (
          <span role="button" tabIndex={0} {...props}>
            {label}
          </span>
        ) : (
          <button type="button" {...props}>
            {label}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent>{act.state === "failed" ? act.said : hint}</TooltipContent>
    </Tooltip>
  );
}

/// The details pane's foot: the issue's tasks, and a composer prefilled with
/// the issue that starts a task right here. Keyed per issue by its caller.
export function IssueComposer({ issue, detail }: { issue: IssueRef; detail: IssueDetail | undefined }) {
  const ctx = useContext(IssueStartContext);
  const seed = issuePrompt(issue, detail?.description ?? null);
  const [text, setText] = useState(seed);
  const [touched, setTouched] = useState(false);
  // The body lands after the pane opens; an untouched box takes it then.
  useEffect(() => {
    if (!touched) setText(seed);
  }, [seed, touched]);
  const [picks, setPicks] = useState<IssuePicks>(lastTaskPicks);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return null;

  const project = ctx.projectFor(issue);
  const tasks = ctx.tasksFor(issue);
  const canStart = !!project && !starting && text.trim().length > 0;
  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    try {
      await ctx.start(issue, text, picks);
      setTouched(false);
      setText(seed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 pt-2.5 pb-3">
      {tasks.length > 0 && (
        <div className="flex min-w-0 items-center gap-1.5 text-ui">
          <span className="shrink-0 text-muted-foreground">Task</span>
          <SessionLink item={tasks[0]} bot={ctx.botOf(tasks[0])} onOpen={() => ctx.onOpenTask(tasks[0])} />
          {tasks.length > 1 && <span className="shrink-0 text-muted-foreground">+{tasks.length - 1} more</span>}
        </div>
      )}
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-ui text-muted-foreground">
        <FolderGit2 className="size-3.5 shrink-0" />
        <span className="truncate">
          {project ? (
            <>
              New task in <span className="text-foreground">{project.name}</span>
            </>
          ) : (
            `${noProject(issue)}.`
          )}
        </span>
      </div>
      <div className="rounded-2xl bg-composer">
        <textarea
          rows={3}
          value={text}
          aria-label="Prompt for the task"
          onChange={(e) => {
            setTouched(true);
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void start();
            }
          }}
          className="block max-h-56 min-h-20 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-ui outline-none placeholder:text-muted-foreground field-sizing-content"
        />
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden [&_button]:min-w-0 [&_button>span]:min-w-0 [&_button>span]:truncate">
            <TaskModelPicker
              server={project ? serverOfPath(project.path) : LOCAL}
              picks={picks}
              onChange={(next) => setPicks({ ...picks, ...next })}
              onRepair={(next) => setPicks((prev) => ({ ...prev, ...next }))}
            />
            <WorktreeToggle on={picks.useWorktree} onToggle={() => setPicks({ ...picks, useWorktree: !picks.useWorktree })} />
          </div>
          <span className="shrink-0">
            <SendButton disabled={!canStart} onClick={() => void start()} title={starting ? "Starting…" : "Start task"} />
          </span>
        </div>
      </div>
      {error && <p className="text-ui text-destructive">{error}</p>}
    </div>
  );
}
