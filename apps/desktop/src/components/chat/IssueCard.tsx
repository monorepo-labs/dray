import { createContext, useContext, useState } from "react";
import { Check, CircleCheck } from "lucide-react";

import IssueLabelChip from "@/components/IssueLabelChip";
import IssueStateIcon from "@/components/IssueStateIcon";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openIssue } from "@/lib/issue";
import { READY, rowRef, rowState, type IssueApprovals } from "@/lib/issueCard";
import { invoke } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { AgentEvent, IssueCardRow, IssueLabel } from "@/types/events";

/// What the chat a card sits in says about it: each card's approvals, and
/// whether it can still take one — a settled chat has no agent to tell.
export const IssueCardChatContext = createContext<{ approvals: IssueApprovals; closed: boolean }>({
  approvals: new Map(),
  closed: true,
});

/// Labels a row draws before it counts the rest, so a long title keeps room.
const SHOWN_LABELS = 2;

/// GitHub issues posted into the chat by `dray session issue-card`. A row
/// opens its issue on the issues page; its check approves it.
export default function IssueCard({ event }: { event: AgentEvent }) {
  const chat = useContext(IssueCardChatContext);
  if (event.payload.type !== "issue_card") return null;
  const { title, repo, issues } = event.payload;
  const approved = chat.approvals.get(event.id);
  const heading = title || (issues.length === 1 ? "1 issue" : `${issues.length} issues`);

  return (
    // The merge card's surface: `--shadow-card` lifts it in light, a
    // half-pixel edge draws it in dark, where that shadow is `none`.
    <div className="w-full max-w-lg self-start rounded-2xl bg-card p-1.5 shadow-[var(--shadow-raised-card,var(--shadow-card))] dark:border-[0.5px] dark:border-border/50">
      <div className="flex items-baseline gap-2 px-2 pt-1.5 pb-1">
        <span className="min-w-0 truncate text-chat font-medium">{heading}</span>
        <span className="ml-auto shrink-0 truncate text-ui text-muted-foreground">{repo}</span>
      </div>
      <ul>
        {issues.map((row) => (
          <Row key={row.number} event={event} repo={repo} row={row} approved={approved} closed={chat.closed} />
        ))}
      </ul>
    </div>
  );
}

function Row({
  event,
  repo,
  row,
  approved,
  closed,
}: {
  event: AgentEvent;
  repo: string;
  row: IssueCardRow;
  approved: Map<number, IssueLabel[]> | undefined;
  closed: boolean;
}) {
  const state = rowState(row, approved);
  const extra = state.labels.length - SHOWN_LABELS;
  return (
    <li className="flex items-center gap-0.5">
      <button
        type="button"
        // The issues page on a click, GitHub on ⌘-click, as an issue tag does.
        onClick={(e) => openIssue(rowRef(repo, row), e)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui hover:bg-[var(--fill-soft,var(--muted))]"
      >
        <IssueStateIcon
          kind={row.closed ? "completed" : "unstarted"}
          // GitHub's own two, as `states()` in github.rs gives the issues page.
          color={row.closed ? "#8250df" : "#1a7f37"}
          label={row.closed ? "Closed" : "Open"}
        />
        <span className="shrink-0 text-muted-foreground tabular-nums">#{row.number}</span>
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
        {state.labels.slice(0, SHOWN_LABELS).map((label) => (
          <IssueLabelChip key={label.name} label={label} className="max-w-28 truncate text-xs" />
        ))}
        {extra > 0 && (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={state.labels.slice(SHOWN_LABELS).map((l) => l.name).join(", ")}
          >
            +{extra}
          </span>
        )}
      </button>
      <Approve event={event} row={row} approved={state.approved} closed={closed || row.closed} />
    </li>
  );
}

/// The row's check: approves it, or says it is approved. Keeps its width
/// where it offers neither, so the rows stay aligned.
function Approve({
  event,
  row,
  approved,
  closed,
}: {
  event: AgentEvent;
  row: IssueCardRow;
  approved: boolean;
  closed: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (approved) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-7 shrink-0 items-center justify-center" aria-label={`#${row.number} approved`}>
            <CircleCheck className="size-4.5 fill-accent-add text-card" strokeWidth={2.25} />
          </span>
        </TooltipTrigger>
        <TooltipContent>Approved</TooltipContent>
      </Tooltip>
    );
  }
  if (closed) return <span className="size-7 shrink-0" />;

  const approve = async () => {
    setSending(true);
    setError(null);
    try {
      await invoke("approve_issue", { sessionId: event.sessionId, cardId: event.id, number: row.number });
    } catch (e) {
      setError(String(e));
    } finally {
      // The logged approval has landed by now, so `approved` takes over.
      setSending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Approve #${row.number}`}
          disabled={sending}
          onClick={() => void approve()}
          className={cn("text-muted-foreground hover:text-accent-add", error && "text-destructive")}
        >
          {sending ? <Spinner className="size-3.5" /> : <Check className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{error ? `Couldn't approve: ${error}` : `Approve: label it ${READY} and start`}</TooltipContent>
    </Tooltip>
  );
}
