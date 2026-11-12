import { ExternalLink } from "lucide-react";
import { createContext, useContext } from "react";

import BotAvatar from "@/components/BotAvatar";
import PrStateIcon from "@/components/PrStateIcon";
import { MergeControl } from "@/components/TasksPanel";
import { Button } from "@/components/ui/button";
import { seededAvatar } from "@/lib/botAvatar";
import { FULL_FOR, type MergeCardPayload } from "@/lib/mergeCard";
import { openLink } from "@/lib/openLink";
import { isModClick } from "@/lib/platform";
import { mergeVerdict, readyToMerge } from "@/lib/pr";
import { cn } from "@/lib/utils";
import type { AgentEvent, MergeMethod, PrMark } from "@/types/events";

/// What a card needs from the app: the sidebar's PR marks for live status,
/// the task's current title, and the Tasks tab's merge.
export type MergeCardHost = {
  prFor: (repo: string, branch: string) => PrMark | undefined;
  titleOf: (taskId: string) => string | undefined;
  /// `settle`: a bot's chat, where landed work is the bot's to tidy, so the
  /// task is settled and its worktree deleted after the merge.
  merge: (card: MergeCardPayload, method: MergeMethod, settle: boolean) => Promise<void>;
  open: (taskId: string, alone: boolean) => void;
};

export const MergeCardHostContext = createContext<MergeCardHost | null>(null);

/// What the chat a card sits in says about it: how many of the reader's
/// messages followed each card, and whether this is a bot's chat.
export const MergeCardChatContext = createContext<{ after: Map<string, number>; bot: boolean }>({
  after: new Map(),
  bot: false,
});

const VERDICT_WORDS: Record<ReturnType<typeof mergeVerdict>, string> = {
  merged: "Merged",
  closed: "Closed without merging",
  conflict: "Conflicts with base",
  unknown: "Checking mergeability…",
  draft: "Draft",
  behind: "Behind base",
  blocked: "Blocked",
  unstable: "Checks not passing",
  ready: "Ready to merge",
};

const CHECK_WORDS = { RUNNING: "Checks running", FAILING: "Checks failing", CLEAR: null } as const;

/// The PR's state in words: the checks where they say something, then what
/// GitHub says about merging.
function statusLine(pr: PrMark | undefined): string {
  if (!pr) return "Reading status…";
  const verdict = VERDICT_WORDS[mergeVerdict(pr)];
  const checks = pr.state === "OPEN" ? CHECK_WORDS[pr.checksState] : null;
  return checks && verdict !== "Checks not passing" ? `${checks} · ${verdict}` : verdict;
}

/// A task's pull request, posted into the chat by `dray session merge-card`.
/// Whole while it is new and unmerged; one line once merged, or once the
/// reader has moved on by `FULL_FOR` messages. It never goes away unmerged.
export default function MergeCard({ event }: { event: AgentEvent }) {
  const host = useContext(MergeCardHostContext);
  const chat = useContext(MergeCardChatContext);
  if (event.payload.type !== "merge_card") return null;
  const card = event.payload;

  const mark = host?.prFor(card.projectPath, card.branch);
  // The branch's mark may be a later PR from the same branch; this card is
  // about its own.
  const pr = mark?.number === card.number ? mark : undefined;
  const merged = pr?.state === "MERGED";
  const title = host?.titleOf(card.taskId) ?? card.title;
  const mergeable = pr?.state === "OPEN" && !pr.isDraft && readyToMerge(pr) === true;
  const compact = merged || (chat.after.get(event.id) ?? 0) >= FULL_FOR;
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
        {mergeable && merge && <MergeControl onMerge={merge} />}
      </div>
    );
  }

  return (
    <div className="w-full max-w-md self-start rounded-2xl border border-border bg-card p-3.5 shadow-(--shadow-card)">
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
            <span className="shrink-0 tabular-nums">#{card.number}</span>
            <span aria-hidden>·</span>
            <span className={cn("truncate", pr?.checksState === "FAILING" && pr.state === "OPEN" && "text-destructive")}>
              {statusLine(pr)}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={(e) => openLink(card.url, e)}>
          Open on GitHub
          <ExternalLink />
        </Button>
        {mergeable && merge && <MergeControl onMerge={merge} />}
      </div>
    </div>
  );
}
