import { createContext, useContext, useState, type MouseEvent } from "react";
import { Check, Play } from "lucide-react";

import GitHubIcon from "@/components/GitHubIcon";
import IssueLabelChip from "@/components/IssueLabelChip";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/useTheme";
import { openIssue } from "@/lib/issue";
import { rowRef, type IssueStarts } from "@/lib/issueCard";
import { invoke } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { AgentEvent, IssueCardRow, IssueLabel } from "@/types/events";

/// What the chat a card sits in says about it: each card's issues already
/// handed to the agent, and whether it can still take one — a settled chat
/// has no agent to tell.
export const IssueCardChatContext = createContext<{ starts: IssueStarts; closed: boolean }>({
  starts: new Map(),
  closed: true,
});

/// The merge card's surface: `--shadow-card` lifts it in light, a half-pixel
/// edge draws it in dark, where that shadow is `none`.
const SURFACE = "bg-card shadow-[var(--shadow-raised-card,var(--shadow-card))] dark:border-[0.5px] dark:border-border/50";

/// GitHub's own closed purple, light and dark: its light one is too deep to
/// read on a dark card, which is why `readableStateColor` alone, leaving dark
/// untouched, is not enough here. Open takes no colour of its own.
const CLOSED_COLOR = { light: "#8250df", dark: "#a371f7" } as const;

/// GitHub issues posted into the chat by `dray session issue-card`, one or
/// several, each on a tile of its own. An issue opens on the issues page; its
/// play button hands it to the agent to work on.
export default function IssueCard({ event }: { event: AgentEvent }) {
  const chat = useContext(IssueCardChatContext);
  const { resolvedMode } = useTheme();
  if (event.payload.type !== "issue_card") return null;
  // `title` is not drawn: a heading over the list read as noise.
  const { repo, issues } = event.payload;
  const started = chat.starts.get(event.id);
  const closedColor = CLOSED_COLOR[resolvedMode === "light" ? "light" : "dark"];
  return (
    <div className={cn("w-full max-w-lg self-start rounded-xl p-1", SURFACE)}>
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
        <GitHubIcon className="size-3" />
        <span className="truncate">{repo}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {issues.map((row) => (
          <Tile
            key={row.number}
            row={row}
            color={row.closed ? closedColor : undefined}
            // The issues page on a click, GitHub on ⌘-click, as an issue tag does.
            open={(e) => openIssue(rowRef(repo, row), e)}
            action={
              row.closed ? null : (
                <WorkOn event={event} row={row} started={started?.has(row.number) === true} closed={chat.closed} />
              )
            }
          />
        ))}
      </ul>
    </div>
  );
}

/// One issue on a tile of its own, outlined in light and filled in dark; the gap
/// between tiles separates them. A closed issue's number turns purple.
function Tile({
  row,
  color,
  open,
  action,
}: {
  row: IssueCardRow;
  /// Set for a closed issue alone; an open one keeps the muted number.
  color: string | undefined;
  open: (e: MouseEvent) => void;
  action: React.ReactNode;
}) {
  return (
    // Light outlines each tile, dark fills it. The border stays in dark, clear,
    // so a tile is the same size in both modes.
    <li className="flex items-center gap-1 rounded-lg border border-border hover:bg-[var(--fill-soft,var(--muted))] dark:border-transparent dark:bg-[color-mix(in_oklab,var(--muted)_55%,transparent)]">
      <button type="button" onClick={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-ui">
        <span className="shrink-0 text-muted-foreground tabular-nums" style={{ color }} aria-label={`#${row.number}, ${row.closed ? "closed" : "open"}`}>
          #{row.number}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", row.closed && "text-muted-foreground")}>{row.title}</span>
        <LabelDots labels={row.labels} />
      </button>
      {/* One width for the button, Started and nothing, so the rows line up. */}
      <span className="flex w-20 shrink-0 justify-end pr-1">{action}</span>
    </li>
  );
}

function LabelDots({ labels }: { labels: IssueLabel[] }) {
  if (labels.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center gap-0.5">
          {labels.slice(0, 4).map((label) => (
            <IssueLabelChip key={label.name} label={label} dot />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{labels.map((l) => l.name).join(", ")}</TooltipContent>
    </Tooltip>
  );
}

/// The play button: hands the issue to the agent, then says Started. Nothing
/// in a settled chat, unless it was already started.
function WorkOn({ event, row, started, closed }: { event: AgentEvent; row: IssueCardRow; started: boolean; closed: boolean }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (started) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 px-1.5 text-xs text-muted-foreground">
        <Check className="size-3.5 text-accent-add" />
        Started
      </span>
    );
  }
  if (closed) return null;

  const start = async () => {
    setSending(true);
    setError(null);
    try {
      await invoke("approve_issue", { sessionId: event.sessionId, cardId: event.id, number: row.number });
    } catch (e) {
      setError(String(e));
    } finally {
      // The logged hand-off has landed by now, so `started` takes over.
      setSending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Work on #${row.number}`}
          disabled={sending}
          onClick={() => void start()}
          className={cn("text-muted-foreground hover:text-foreground", error && "text-destructive")}
        >
          {sending ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{error ? `Couldn't start: ${error}` : "Work on it"}</TooltipContent>
    </Tooltip>
  );
}
