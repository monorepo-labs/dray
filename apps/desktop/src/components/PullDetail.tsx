import { useCallback, useEffect, useMemo, useState } from "react";

import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";

import BotAvatar from "@/components/BotAvatar";
import PrPanel, { CommentPickContext } from "@/components/PrPanel";
import { EFFORT_LABELS } from "@/components/composer/ModelSelector";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import type { usePullRequest } from "@/hooks/usePullRequest";
import { AGENT_LABELS, rememberedModel, usableEffort, usableModel } from "@/lib/model";
import { prPrompt, unresolvedKeys, type InboxRow, type PrPicks } from "@/lib/prInbox";
import { sendToTask } from "@/lib/sendToTask";
import { invoke, type ServerId } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Bot, Model, SessionIndexItem } from "@/types/events";

/// The picked pull request on the pull requests page: the PR panel's own rows,
/// with a box on each comment, the session working on it, and under them a
/// composer that messages that session — or, with none, starts one right here
/// on the PR's own branch, the reader's own or a bot's task. Mounted once per
/// PR (keyed by `App`), so picks never carry across.
export default function PullDetail({
  row,
  data,
  sessions,
  bots,
  botOf,
  server,
  onOpenSession,
  onStart,
}: {
  row: InboxRow;
  data: ReturnType<typeof usePullRequest>;
  /// `sessionsForPr`'s answer, best first.
  sessions: SessionIndexItem[];
  /// The bots that can take this PR as a task: those on its checkout's server.
  bots: Bot[];
  /// The bot a session is a task of, if any.
  botOf: (item: SessionIndexItem) => Bot | undefined;
  /// Where the PR's checkout lives, or `null` with none attached.
  server: ServerId | null;
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

  const live = sessions.filter((s) => !s.archived);
  const [targetId, setTargetId] = useState<string | null>(null);
  const target = live.find((s) => s.sessionId === targetId) ?? live[0] ?? null;

  const [text, setText] = useDraft(`pr:${row.mark.url}`);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: SessionIndexItem } | { error: string } | null>(null);
  const writable = !row.listing.isCrossRepository;
  // Starting needs no words: the PR and its comments are a task on their own.
  const canSend = !!pr && writable && !sending && (!target || text.trim().length > 0 || picked.size > 0);
  const [picks, setPicks] = useStartPicks(sessions.find((s) => s.archived));

  const send = async (bot: Bot | null = null) => {
    if (!canSend || !pr) return;
    setSending(true);
    setResult(null);
    try {
      if (!target) {
        const answer = await onStart(prPrompt({ pr, picked, text, fresh: true }), picks, bot);
        if ("error" in answer) return setResult(answer);
        setText("");
        setPicked(new Set());
        setResult({ sent: answer.started });
        return;
      }
      await sendToTask(target, prPrompt({ pr, picked, text }));
      setText("");
      setPicked(new Set());
      setResult({ sent: target });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {live.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 text-ui">
          <span className="shrink-0 text-muted-foreground">{live.length > 1 ? "Tasks" : "Task"}</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {live.map((s) => (
              <SessionLink key={s.sessionId} item={s} bot={botOf(s)} onOpen={() => onOpenSession(s)} />
            ))}
          </div>
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
            ) : target ? (
              <>
                <span className="shrink-0">To</span>
                <SessionMenu sessions={live} target={target} botOf={botOf} onPick={setTargetId} />
              </>
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
                placeholder={target ? "Message the agent about this pull request" : "What should the agent do with this pull request?"}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
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
                {target ? (
                  <Button size="xs" className="ml-auto" disabled={!canSend} onClick={() => void send()}>
                    {sending ? "Sending…" : "Send"}
                  </Button>
                ) : (
                  <div className="ml-auto flex items-center gap-1.5">
                    <BotButton bots={bots} disabled={!canSend} onSend={(bot) => void send(bot)} />
                    <Button size="xs" disabled={!canSend || !server} onClick={() => void send()}>
                      {sending ? "Starting…" : "Start Task"}
                    </Button>
                  </div>
                )}
              </div>
              {!target && server && <PicksRow server={server} picks={picks} onChange={setPicks} />}
            </>
          )}

          {result && (
            <p className={cn("text-ui", "error" in result ? "text-destructive" : "text-muted-foreground")}>
              {"error" in result ? (
                result.error
              ) : (
                <>
                  Sent to{" "}
                  <button
                    type="button"
                    className="text-foreground underline-offset-2 hover:underline"
                    onClick={() => onOpenSession(result.sent)}
                  >
                    {/* The live row's title: a new session's is replaced once generated. */}
                    {botOf(result.sent)
                      ? `${botOf(result.sent)?.name}'s task`
                      : (sessions.find((s) => s.sessionId === result.sent.sessionId) ?? result.sent).title}
                  </button>
                  .
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/// A session working on the PR, by name, opening it on click. A bot's task
/// wears its bot's face and name, since the bot is who the reader talks to.
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
            "flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            className,
          )}
        >
          {bot && <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-3.5 shrink-0 scale-[1.18]" />}
          <span className="min-w-0 truncate">{bot ? `${bot.name} · ${item.title}` : item.title}</span>
          <ChevronRight className="size-3 shrink-0 opacity-60" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{bot ? `Open ${bot.name}'s task` : "Open task"}</TooltipContent>
    </Tooltip>
  );
}

/// Which session the message goes to. A menu only where the branch has more
/// than one live session, which is rare; otherwise just its title.
function SessionMenu({
  sessions,
  target,
  botOf,
  onPick,
}: {
  sessions: SessionIndexItem[];
  target: SessionIndexItem;
  botOf: (item: SessionIndexItem) => Bot | undefined;
  onPick: (id: string) => void;
}) {
  const name = (s: SessionIndexItem) => (botOf(s) ? `${botOf(s)?.name} · ${s.title}` : s.title);
  if (sessions.length < 2) {
    return <span className="min-w-0 truncate text-foreground">{name(target)}</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex min-w-0 items-center gap-1 text-foreground">
          <span className="truncate">{name(target)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {sessions.map((s) => (
          <DropdownMenuCheckboxItem
            key={s.sessionId}
            checked={s.sessionId === target.sessionId}
            onCheckedChange={() => onPick(s.sessionId)}
          >
            {name(s)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// Send to bot: one bot is named on the button, several get a menu. The task
/// runs on the bot's own agent, in its own worktree on the PR's branch.
function BotButton({ bots, disabled, onSend }: { bots: Bot[]; disabled: boolean; onSend: (bot: Bot) => void }) {
  if (bots.length === 0) return null;
  if (bots.length === 1) {
    const [bot] = bots;
    return (
      <Button variant="outline" size="xs" disabled={disabled} onClick={() => onSend(bot)}>
        <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-3.5 scale-[1.18]" />
        Send to {bot.name}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" disabled={disabled}>
          Send to bot
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {bots.map((bot) => (
          <DropdownMenuItem key={bot.id} onSelect={() => onSend(bot)}>
            <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-4 scale-[1.18]" />
            {bot.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// What Start Task runs on: the newest settled session's agent and model,
/// since that is the agent that did the work, else a new task's remembered
/// ones — never the selected session's, which the main composer mirrors.
/// Always Auto: the pane offers no stance, and a stance carried over from a
/// settled session or the composer is one the reader never saw here.
function useStartPicks(settled: SessionIndexItem | undefined) {
  return useState<PrPicks>(() => {
    if (settled) {
      const { harness, model, effort, fast } = settled;
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

/// The agent and model Start Task uses, the model changeable in place. The
/// list is the server's own, read once per agent.
function PicksRow({
  server,
  picks,
  onChange,
}: {
  server: ServerId;
  picks: PrPicks;
  onChange: (picks: PrPicks) => void;
}) {
  const [models, setModels] = useState<Model[]>([]);
  useEffect(() => {
    let gone = false;
    invoke<Model[]>("list_models", { harness: picks.harness }, server)
      .then((list) => !gone && setModels(list))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [server, picks.harness]);
  const model = models.find((m) => m.id === picks.model);
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
    <div className="flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
      <span className="shrink-0">{AGENT_LABELS[picks.harness]}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-foreground hover:bg-sidebar-accent"
          >
            <span className="truncate">{model?.label ?? picks.model}</span>
            {picks.effort && <span className="text-muted-foreground">{EFFORT_LABELS[picks.effort]}</span>}
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuRadioGroup
            value={picks.model}
            onValueChange={(id) => {
              const next = models.find((m) => m.id === id);
              if (next) onChange({ ...picks, model: next.id, effort: usableEffort(next, picks.effort, "high") });
            }}
          >
            {models.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                {m.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
