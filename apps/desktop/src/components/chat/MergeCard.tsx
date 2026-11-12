import { createContext, useContext, useState } from "react";

import BotAvatar from "@/components/BotAvatar";
import { Button } from "@/components/ui/button";
import { ChecksRunningIcon } from "@/components/PrPanel";
import PrStateIcon from "@/components/PrStateIcon";
import { MergeControl } from "@/components/TasksPanel";
import { seededAvatar } from "@/lib/botAvatar";
import { FULL_FOR, type MergeCardPayload } from "@/lib/mergeCard";
import { openLink } from "@/lib/openLink";
import { qualify, serverOfSession } from "@/lib/transport";
import { isModClick } from "@/lib/platform";
import { mergeVerdict, readyToMerge } from "@/lib/pr";
import { cn } from "@/lib/utils";
import type { AgentEvent, MergeMethod, PrMark } from "@/types/events";

/// What a card needs from the app: the sidebar's PR marks for live status,
/// the task's current title, and the Tasks tab's merge.
export type MergeCardHost = {
  /// `undefined` until the repo is read, `null` where it holds no such PR.
  prNumbered: (repo: string, number: number) => PrMark | null | undefined;
  titleOf: (taskId: string) => string | undefined;
  /// `settle`: a bot's chat, where landed work is the bot's to tidy, so the
  /// task is settled and its worktree deleted after the merge.
  merge: (card: MergeCardPayload, method: MergeMethod, settle: boolean) => Promise<void>;
  open: (taskId: string, alone: boolean) => void;
  /// Asks the task's agent to resolve the PR's conflicts and push.
  fixConflicts: (card: MergeCardPayload) => Promise<void>;
};

export const MergeCardHostContext = createContext<MergeCardHost | null>(null);

/// What the chat a card sits in says about it: how many of the reader's
/// messages followed each card, and whether this is a bot's chat.
export const MergeCardChatContext = createContext<{ after: Map<string, number>; bot: boolean }>({
  after: new Map(),
  bot: false,
});

/// Empty where something else already says it, as on the Tasks tab's rows:
/// the PR glyph for a draft and for failing checks, the Merge button for
/// ready, Fix conflicts for a conflict.
const VERDICT_WORDS: Record<ReturnType<typeof mergeVerdict>, string> = {
  merged: "Merged",
  closed: "Closed without merging",
  conflict: "",
  unknown: "Checking mergeability…",
  draft: "",
  behind: "Behind base",
  blocked: "Blocked",
  unstable: "",
  ready: "",
};

/// The PR panel's colours for the same verdicts: yellow while something is
/// still in the way or not passing, red for a conflict, green when it can land.
const VERDICT_TONE: Record<ReturnType<typeof mergeVerdict>, string> = {
  merged: "text-muted-foreground",
  closed: "text-muted-foreground",
  draft: "text-muted-foreground",
  conflict: "text-destructive",
  unknown: "text-accent-command",
  behind: "text-accent-command",
  blocked: "text-accent-command",
  unstable: "text-accent-command",
  ready: "text-accent-add",
};

const statusTone = (pr: PrMark | undefined) => (pr ? VERDICT_TONE[mergeVerdict(pr)] : "text-muted-foreground");

/// What GitHub says about merging, where no glyph or button says it. Running
/// checks draw `ChecksRunningIcon`; failing ones turn the PR glyph red.
const statusLine = (pr: PrMark | undefined) => (pr ? VERDICT_WORDS[mergeVerdict(pr)] : "Reading status…");

/// A task's pull request, posted into the chat by `dray session merge-card`.
/// Whole while it is new and unmerged; one line once merged, or once the
/// reader has moved on by `FULL_FOR` messages. It never goes away unmerged.
export default function MergeCard({ event }: { event: AgentEvent }) {
  const host = useContext(MergeCardHostContext);
  const chat = useContext(MergeCardChatContext);
  if (event.payload.type !== "merge_card") return null;
  // The server wrote its own bare path; qualified, a remote chat's card reads
  // and merges on that server rather than on a local checkout of the same path.
  const card = { ...event.payload, projectPath: qualify(event.payload.projectPath, serverOfSession(event.sessionId)) };

  const found = host?.prNumbered(card.projectPath, card.number);
  const pr = found ?? undefined;
  const merged = pr?.state === "MERGED";
  const title = host?.titleOf(card.taskId) ?? card.title;
  const mergeable = pr?.state === "OPEN" && !pr.isDraft && readyToMerge(pr) === true;
  const conflicted = pr?.state === "OPEN" && mergeVerdict(pr) === "conflict";
  const running = pr?.state === "OPEN" && pr.checksState === "RUNNING";
  const status = statusLine(pr);
  // `null` is a PR no longer among the open or recently merged: nothing left
  // to land, so it draws one line without claiming which way it went.
  const compact = merged || found === null || (chat.after.get(event.id) ?? 0) >= FULL_FOR;
  const merge = host && ((method: MergeMethod) => host.merge(card, method, chat.bot));
  const open = (e: React.MouseEvent) => host?.open(card.taskId, isModClick(e));
  const face = <BotAvatar seed={card.taskId} avatar={seededAvatar(card.taskId)} className="block size-full scale-[1.18]" />;

  if (compact) {
    return (
      <div className="flex max-w-full items-center gap-1.5 self-start text-ui text-muted-foreground">
        <PrStateIcon pr={pr ?? { state: "OPEN", isDraft: false }} strokeWidth={1.5} />
        <button
          type="button"
          className="shrink-0 cursor-pointer tabular-nums hover:text-foreground"
          onClick={(e) => openLink(card.url, e)}
        >
          {merged ? `Merged #${card.number}` : `#${card.number}`}
        </button>
        <span aria-hidden>·</span>
        <button type="button" onClick={open} className="flex min-w-0 cursor-pointer items-center gap-1.5 hover:text-foreground">
          <span className="size-4 shrink-0">{face}</span>
          <span className="truncate">{title}</span>
        </button>
        {mergeable && merge && <MergeControl onMerge={merge} keep={event.id} />}
        {conflicted && host && <FixConflicts onFix={() => host.fixConflicts(card)} />}
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg self-start rounded-2xl border border-border bg-card p-3.5 shadow-(--shadow-card)">
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={open} className="size-7 shrink-0 cursor-pointer" aria-label={`Open ${title}`}>
          {face}
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={open}
            className="block max-w-full cursor-pointer truncate text-left text-chat font-medium hover:underline"
          >
            {title}
          </button>
          <p className="flex items-center gap-1.5 text-ui text-muted-foreground">
            <PrStateIcon pr={pr ?? { state: "OPEN", isDraft: false }} strokeWidth={1.5} />
            {/* Dray's browser on a click, the system's on ⌘-click. */}
            <button
              type="button"
              className="shrink-0 cursor-pointer tabular-nums underline-offset-2 hover:text-foreground hover:underline"
              onClick={(e) => openLink(card.url, e)}
            >
              #{card.number}
            </button>
            {(running || status) && <span aria-hidden>·</span>}
            {running && <ChecksRunningIcon />}
            {status && <span className={cn("truncate", statusTone(pr))}>{status}</span>}
          </p>
        </div>
        {mergeable && merge && <MergeControl onMerge={merge} keep={event.id} named />}
        {conflicted && host && <FixConflicts onFix={() => host.fixConflicts(card)} />}
      </div>
    </div>
  );
}

/// Merge's stand-in while the PR conflicts with its base: hands the fix to the
/// task's own agent, which holds the branch.
function FixConflicts({ onFix }: { onFix: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const fix = async () => {
    setState("sending");
    setError(null);
    try {
      await onFix();
      setState("sent");
    } catch (e) {
      setState("idle");
      setError(String(e));
    }
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {error && (
        <span className="text-[12px] text-destructive" title={error}>
          Failed
        </span>
      )}
      <Button variant="outline" size="xs" disabled={state !== "idle"} onClick={() => void fix()}>
        {state === "sent" ? "Asked the task" : state === "sending" ? "Sending…" : "Fix conflicts"}
      </Button>
    </span>
  );
}
