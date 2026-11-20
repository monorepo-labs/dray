import { useCallback, useEffect, useMemo, useState } from "react";

import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";

import BotAvatar from "@/components/BotAvatar";
import PrPanel, { CommentPickContext } from "@/components/PrPanel";
import Segmented from "@/components/Segmented";
import ModelSelector from "@/components/composer/ModelSelector";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { inputClassName } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readComposerPrefs } from "@/hooks/useComposerPrefs";
import { useDraft } from "@/hooks/useDraft";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import type { usePullRequest } from "@/hooks/usePullRequest";
import { rememberedModel, usableEffort, usableModel } from "@/lib/model";
import { prPrompt, unresolvedKeys, type InboxRow, type PrCheckout, type PrPicks } from "@/lib/prInbox";
import { invoke, type ServerId } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Bot, Model, SessionIndexItem } from "@/types/events";

/// The picked pull request on the pull requests page: the PR panel's own rows,
/// with a box on each comment, every task the PR has had, newest first, and
/// under them a composer that starts another — the reader's own or a bot's —
/// on the PR's own branch. The page only starts tasks: a follow-up is said in
/// the task, or to its bot, where the conversation already is. Mounted once
/// per PR (keyed by `App`), so picks never carry across.
export default function PullDetail({
  row,
  data,
  sessions,
  bots,
  botOf,
  server,
  checkout,
  onOpenSession,
  onStart,
}: {
  row: InboxRow;
  data: ReturnType<typeof usePullRequest>;
  /// `sessionsForPr`'s answer: every task on the PR, newest first.
  sessions: SessionIndexItem[];
  /// The bots that can take this PR as a task: those on its checkout's server.
  bots: Bot[];
  /// The bot a session is a task of, if any.
  botOf: (item: SessionIndexItem) => Bot | undefined;
  /// Where the task runs: the checkout's server, or This Mac, which clones one.
  server: ServerId;
  /// What Start Task does about a checkout first, said under the box: nothing,
  /// attach a checkout already on disk, or clone the repo into `~/dray`.
  checkout: PrCheckout;
  onOpenSession: (item: SessionIndexItem) => void;
  onStart: (
    prompt: string,
    picks: PrPicks,
    bot: Bot | null,
  ) => Promise<{ started: SessionIndexItem } | { error: string }>;
}) {
  // The panel's read answers every PR on the head branch; this pane is one.
  const pr = data.prs.find((p) => p.number === row.mark.number) ?? null;
  const prs = useMemo(() => (pr ? [pr] : []), [pr]);

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const pick = useMemo(() => ({ picked, toggle }), [picked, toggle]);
  const unresolved = useMemo(() => (pr ? unresolvedKeys(pr.comments) : []), [pr]);

  const [text, setText] = useDraft(`pr:${row.mark.url}`);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = !row.listing.isCrossRepository;
  // Starting needs no words: the PR and its comments are a task on their own.
  const canStart = !!pr && writable && !starting;
  const [picks, setPicks] = useStartPicks(sessions[0]);

  const start = async (bot: Bot | null) => {
    if (!canStart || !pr) return;
    setStarting(true);
    setError(null);
    try {
      const answer = await onStart(prPrompt({ pr, picked, text }), picks, bot);
      if ("error" in answer) return setError(answer.error);
      setText("");
      setPicked(new Set());
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sessions.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 text-ui">
          <span className="shrink-0 text-muted-foreground">Task</span>
          <SessionLink item={sessions[0]} bot={botOf(sessions[0])} onOpen={() => onOpenSession(sessions[0])} />
          {sessions.length > 1 && (
            <EarlierTasks sessions={sessions.slice(1)} botOf={botOf} onOpen={onOpenSession} />
          )}
        </div>
      )}

      <CommentPickContext value={pick}>
        <PrPanel {...data} prs={prs} branch={row.mark.headRefName} cwd={row.key} />
      </CommentPickContext>

      {pr && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 pt-2.5 pb-3">
          <div className="flex min-h-6 items-center gap-1.5 text-ui text-muted-foreground">
            {!writable ? (
              <span>Read only. This branch lives in a fork, so an agent here can't push to it.</span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <GitBranch className="size-3.5 shrink-0" />
                <span className="truncate">
                  New worktree on <span className="text-foreground">{row.mark.headRefName}</span>, the PR's own branch
                </span>
              </span>
            )}
          </div>

          {writable && (
            <>
              <textarea
                rows={3}
                value={text}
                placeholder="What should the agent do with this pull request?"
                onChange={(e) => setText(e.target.value)}
                className={cn(inputClassName, "h-auto max-h-48 min-h-16 resize-none py-1.5 text-ui md:text-ui field-sizing-content")}
              />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-ui">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={unresolved.length === 0}
                  onClick={() => setPicked(new Set(unresolved))}
                >
                  Pick unresolved
                </Button>
                {picked.size > 0 && (
                  <>
                    <span className="text-muted-foreground">
                      {picked.size} {picked.size === 1 ? "comment" : "comments"} picked
                    </span>
                    <Button variant="ghost" size="xs" onClick={() => setPicked(new Set())}>
                      Clear
                    </Button>
                  </>
                )}
              </div>
              <StartControls
                bots={bots}
                server={server}
                picks={picks}
                onPicks={setPicks}
                disabled={!canStart}
                starting={starting}
                onStart={(bot) => void start(bot)}
              />
              {checkout.kind !== "here" && (
                <p className="text-ui text-muted-foreground">
                  {checkout.kind === "attach"
                    ? `Attaches ${checkout.path} first, the checkout a task of this repo already uses.`
                    : `No copy of ${checkout.slug} here, so Start Task clones it into ~/dray first.`}
                </p>
              )}
            </>
          )}

          {error && <p className="text-ui text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}

/// A task of the PR, by name, opening it on click: live or settled, since a
/// settled one is still where its work and conversation are. A bot's task
/// wears its bot's face and name, the bot being who the reader talks to.
export function SessionLink({
  item,
  bot,
  onOpen,
  className,
}: {
  item: SessionIndexItem;
  bot: Bot | undefined;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className={cn(
            "flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            item.archived ? "text-muted-foreground" : "text-foreground",
            className,
          )}
        >
          {bot && <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-3.5 shrink-0 scale-[1.18]" />}
          <span className="min-w-0 truncate">{bot ? `${bot.name} · ${item.title}` : item.title}</span>
          {item.archived && <span className="shrink-0 text-muted-foreground/70">· Settled</span>}
          <ChevronRight className="size-3 shrink-0 opacity-60" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{bot ? `Open ${bot.name}'s task` : "Open task"}</TooltipContent>
    </Tooltip>
  );
}

/// The PR's earlier tasks, newest first, behind a count beside the latest.
function EarlierTasks({
  sessions,
  botOf,
  onOpen,
}: {
  sessions: SessionIndexItem[];
  botOf: (item: SessionIndexItem) => Bot | undefined;
  onOpen: (item: SessionIndexItem) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-muted-foreground hover:bg-sidebar-accent"
        >
          {sessions.length} earlier
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {sessions.map((s) => {
          const bot = botOf(s);
          return (
            <DropdownMenuItem key={s.sessionId} onSelect={() => onOpen(s)}>
              {bot && <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-4 scale-[1.18]" />}
              <span className="min-w-0 flex-1 truncate">{bot ? `${bot.name} · ${s.title}` : s.title}</span>
              {s.archived && <span className="shrink-0 text-muted-foreground">Settled</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// The bot a PR task last went to, the default the next time.
const LAST_BOT_KEY = "dray.prStartBot";
/// The switch's last side, so it opens where the reader left it.
const LAST_MODE_KEY = "dray.prStartMode";

/// How a task for the PR starts: a switch between a bot's task and the
/// reader's own, over one Start button. A bot's task runs on the bot's own
/// agent, so the model picker belongs to the plain task alone.
function StartControls({
  bots,
  server,
  picks,
  onPicks,
  disabled,
  starting,
  onStart,
}: {
  bots: Bot[];
  server: ServerId;
  picks: PrPicks;
  onPicks: (picks: PrPicks) => void;
  disabled: boolean;
  starting: boolean;
  onStart: (bot: Bot | null) => void;
}) {
  const [botId, setBotId] = useLocalStorage<string | null>(LAST_BOT_KEY, null);
  const [mode, setMode] = useLocalStorage<"bot" | "task">(LAST_MODE_KEY, "bot");
  const bot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;
  const toBot = !!bot && mode === "bot";
  const start = () => {
    if (toBot) setBotId(bot.id);
    onStart(toBot ? bot : null);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {bot && (
        <Segmented
          value={mode}
          options={[
            // With several, the menu beside it names the bot, so the half
            // says only what kind of task this is.
            bots.length > 1
              ? { value: "bot", label: "Bot" }
              : {
                  value: "bot",
                  label: bot.name,
                  content: (
                    <span className="flex items-center gap-1">
                      <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-3.5 scale-[1.18]" />
                      {bot.name}
                    </span>
                  ),
                },
            { value: "task", label: "Task" },
          ]}
          onPick={setMode}
          label="Start as"
        />
      )}
      {toBot && bots.length > 1 && <BotMenu bots={bots} bot={bot} onPick={setBotId} />}
      {!toBot && <TaskModelPicker server={server} picks={picks} onChange={onPicks} />}
      <Button size="xs" className="ml-auto" disabled={disabled} onClick={start}>
        {starting ? "Starting…" : toBot ? `Start task in ${bot.name}` : "Start Task"}
      </Button>
    </div>
  );
}

/// The switch's bot pick, beside it where there are several.
function BotMenu({ bots, bot, onPick }: { bots: Bot[]; bot: Bot; onPick: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1 py-0.5 text-ui text-foreground hover:bg-sidebar-accent"
        >
          <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-3.5 scale-[1.18]" />
          {bot.name}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuRadioGroup value={bot.id} onValueChange={onPick}>
          {bots.map((b) => (
            <DropdownMenuRadioItem key={b.id} value={b.id}>
              <BotAvatar seed={b.id} avatar={b.avatar} className="block size-4 scale-[1.18]" />
              {b.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// What Start Task runs on: the PR's latest task's agent and model, since
/// that is the agent that did the work, else a new task's remembered
/// ones — never the selected session's, which the main composer mirrors.
/// Always Auto: the pane offers no stance, and a stance carried over from a
/// settled session or the composer is one the reader never saw here.
function useStartPicks(latest: SessionIndexItem | undefined) {
  return useState<PrPicks>(() => {
    if (latest) {
      const { harness, model, effort, fast } = latest;
      return { harness, model, effort, permissionMode: "auto", fast };
    }
    const stored = readComposerPrefs();
    const model = rememberedModel(stored.modelByHarness, stored.harness);
    return {
      harness: stored.harness,
      model,
      effort: stored.effortByModel[model] ?? null,
      permissionMode: "auto",
      fast: stored.fast,
    };
  });
}

/// The New Task composer's own model picker, on the page's picks: the agent
/// row, models, effort and fast mode, read from the task's server. A bot's
/// task never shows it, since it runs on the bot's own agent.
function TaskModelPicker({
  server,
  picks,
  onChange,
}: {
  server: ServerId;
  picks: PrPicks;
  onChange: (picks: PrPicks) => void;
}) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let gone = false;
    setLoading(true);
    invoke<Model[]>("list_models", { harness: picks.harness }, server)
      .then((list) => !gone && setModels(list))
      .catch(() => {})
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
    };
  }, [server, picks.harness, generation]);

  // Repaired once the list lands, as the main composer repairs its own: a
  // remembered model this agent no longer runs, or an effort it lacks, would
  // reach the server as a pick nobody made.
  useEffect(() => {
    if (models.length === 0) return;
    const runs = models.find((m) => m.id === usableModel(models, picks.model, picks.harness));
    if (!runs) return;
    const effort = usableEffort(runs, picks.effort, "high");
    if (runs.id !== picks.model || effort !== picks.effort) onChange({ ...picks, model: runs.id, effort });
  }, [models, picks, onChange]);

  return (
    <ModelSelector
      server={server}
      harness={picks.harness}
      onHarnessChange={(harness) => {
        const stored = readComposerPrefs();
        const model = rememberedModel(stored.modelByHarness, harness);
        setModels([]);
        onChange({ ...picks, harness, model, effort: stored.effortByModel[model] ?? null });
      }}
      models={models}
      modelId={picks.model}
      effort={picks.effort}
      fast={picks.fast}
      onFastChange={(fast) => onChange({ ...picks, fast })}
      fastNote={null}
      isNewSession
      busy={false}
      onChange={(model, effort) => onChange({ ...picks, model, effort })}
      onRefreshModels={() => {
        void invoke("refresh_models", {}, server)
          .catch(() => {})
          .finally(() => setGeneration((n) => n + 1));
      }}
      onReloadModels={() => setGeneration((n) => n + 1)}
      onSeedProvider={() => {}}
      loadingModels={loading}
    />
  );
}
