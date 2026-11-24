import { createContext, useContext, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Check, Play } from "lucide-react";

import GitHubIcon from "@/components/GitHubIcon";
import IssueLabelChip from "@/components/IssueLabelChip";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
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

// Two takes on the compact card while one is picked, switched from a
// dev-only row over each card. Goes once the pick is made.
type Design = "compact" | "tiles";
const DESIGNS: { value: Design; label: string }[] = [
  { value: "compact", label: "C · Compact" },
  { value: "tiles", label: "C2 · Tiles" },
];
const DESIGN_KEY = "dray.issueCardDesign";
const designChanged = channel<void>();
const readDesign = (): Design => (readLocalStorage<string>(DESIGN_KEY, "compact") === "tiles" ? "tiles" : "compact");
const setDesign = (design: Design) => {
  writeLocalStorage(DESIGN_KEY, design);
  designChanged.emit();
};

type Row = { row: IssueCardRow; open: (e: MouseEvent) => void; action: React.ReactNode };

/// GitHub issues posted into the chat by `dray session issue-card`, one or
/// several. An issue opens on the issues page; its play button hands it to the
/// agent to work on.
export default function IssueCard({ event }: { event: AgentEvent }) {
  const chat = useContext(IssueCardChatContext);
  const design = useSyncExternalStore(designChanged.subscribe, readDesign);
  if (event.payload.type !== "issue_card") return null;
  const { title, repo, issues } = event.payload;
  const started = chat.starts.get(event.id);
  const rows: Row[] = issues.map((row) => ({
    row,
    // The issues page on a click, GitHub on ⌘-click, as an issue tag does.
    open: (e) => openIssue(rowRef(repo, row), e),
    action: <WorkOn event={event} row={row} started={started?.has(row.number) === true} closed={chat.closed} />,
  }));
  return (
    <div className="flex w-full max-w-lg flex-col gap-1.5 self-start">
      {import.meta.env.DEV && <DesignSwitch design={design} />}
      <div className={cn("rounded-xl p-1", SURFACE)}>
        <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
          <GitHubIcon className="size-3" />
          <span className="truncate">{repo}</span>
          {title && <span className="ml-auto shrink-0">{title}</span>}
        </div>
        <ul className={cn(design === "tiles" && "flex flex-col gap-0.5")}>
          {rows.map((r) => (
            <Item key={r.row.number} {...r} tile={design === "tiles"} single={rows.length === 1} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function DesignSwitch({ design }: { design: Design }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="mr-1">Design</span>
      {DESIGNS.map((d) => (
        <button
          key={d.value}
          type="button"
          onClick={() => setDesign(d.value)}
          className={cn(
            "cursor-pointer rounded-md px-1.5 py-0.5",
            d.value === design ? "bg-[var(--fill-soft,var(--muted))] text-foreground" : "hover:text-foreground",
          )}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

/// The merge card's surface: `--shadow-card` lifts it in light, a half-pixel
/// edge draws it in dark, where that shadow is `none`.
const SURFACE = "bg-card shadow-[var(--shadow-raised-card,var(--shadow-card))] dark:border-[0.5px] dark:border-border/50";

/// One issue: number, title and label dots on one line, the description's
/// opening under it when it is the card's only issue. A tile sits on a fill of
/// its own, and the gap between tiles is what separates them.
function Item({ row, open, action, tile, single }: Row & { tile: boolean; single: boolean }) {
  return (
    <li
      className={cn(
        "rounded-lg",
        tile
          ? "bg-[color-mix(in_oklab,var(--muted)_55%,transparent)] hover:bg-[var(--fill-soft,var(--muted))]"
          : "hover:bg-[var(--fill-soft,var(--muted))]",
      )}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={open}
          className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-left text-ui", tile ? "py-2" : "py-1.5")}
        >
          <span className="shrink-0 text-muted-foreground tabular-nums">#{row.number}</span>
          <span className={cn("min-w-0 flex-1 truncate", row.closed && "text-muted-foreground")}>{row.title}</span>
          <LabelDots labels={row.labels} />
        </button>
        {/* One width for the button, Started and Closed, so the rows line up. */}
        <span className="flex w-20 shrink-0 justify-end pr-1">{row.closed ? <Closed /> : action}</span>
      </div>
      {/* Padding outside the clamp, or the clipped third line shows in it. */}
      {single && row.excerpt && (
        <div className="px-2.5 pb-2">
          <p className="line-clamp-2 text-xs text-muted-foreground">{row.excerpt}</p>
        </div>
      )}
    </li>
  );
}

/// What says a row is closed, now that no state glyph does.
function Closed() {
  return <span className="px-1.5 text-xs text-muted-foreground">Closed</span>;
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
