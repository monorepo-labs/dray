import { createContext, useContext, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Check } from "lucide-react";

import Avatar from "@/components/Avatar";
import GitHubIcon from "@/components/GitHubIcon";
import IssueLabelChip from "@/components/IssueLabelChip";
import IssueStateIcon from "@/components/IssueStateIcon";
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

// Three designs side by side while one is picked, switched from a dev-only
// row over each card. Goes once the pick is made, with the two not taken.
type Design = "list" | "cards" | "compact";
const DESIGNS: { value: Design; label: string }[] = [
  { value: "list", label: "A · List" },
  { value: "cards", label: "B · Cards" },
  { value: "compact", label: "C · Compact" },
];
const DESIGN_KEY = "dray.issueCardDesign";
const designChanged = channel<void>();
const readDesign = () => readLocalStorage<Design>(DESIGN_KEY, "list");
const setDesign = (design: Design) => {
  writeLocalStorage(DESIGN_KEY, design);
  designChanged.emit();
};

type Row = { row: IssueCardRow; open: (e: MouseEvent) => void; action: React.ReactNode };

/// GitHub issues posted into the chat by `dray session issue-card`, one or
/// several. An issue opens on the issues page; Work on it hands it to the agent.
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
    action: (
      <WorkOn
        event={event}
        row={row}
        started={started?.has(row.number) === true}
        closed={chat.closed || row.closed}
        look={design}
      />
    ),
  }));
  const Body = design === "cards" ? Cards : design === "compact" ? Compact : List;
  return (
    <div className="flex w-full max-w-lg flex-col gap-1.5 self-start">
      {import.meta.env.DEV && <DesignSwitch design={design} />}
      <Body title={title ?? null} repo={repo} rows={rows} />
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

const heading = (title: string | null, count: number) => title || (count === 1 ? "" : `${count} issues`);

/// A: one card, a two-line row per issue under a repo header.
function List({ title, repo, rows }: { title: string | null; repo: string; rows: Row[] }) {
  return (
    <div className={cn("rounded-2xl", SURFACE)}>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <GitHubIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 truncate text-ui text-muted-foreground">{repo}</span>
        <span className="ml-auto shrink-0 text-ui font-medium">{heading(title, rows.length)}</span>
      </div>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {rows.map(({ row, open, action }) => (
          <li key={row.number} className="flex items-center gap-3 px-4 py-2.5">
            <button type="button" onClick={open} className="group flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left">
              <StateIcon row={row} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium group-hover:underline">{row.title}</span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0 tabular-nums">#{row.number}</span>
                  {row.author && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{row.author.name}</span>
                    </>
                  )}
                  <Labels labels={row.labels} max={2} />
                </span>
                {rows.length === 1 && row.excerpt && (
                  <span className="mt-1.5 line-clamp-2 block text-ui text-muted-foreground">{row.excerpt}</span>
                )}
              </span>
            </button>
            {action}
          </li>
        ))}
      </ul>
    </div>
  );
}

/// B: a card per issue, its description's opening under the title.
function Cards({ title, repo, rows }: { title: string | null; repo: string; rows: Row[] }) {
  return (
    <div className="flex flex-col gap-2">
      {(title || rows.length > 1) && (
        <span className="px-1 text-ui text-muted-foreground">
          {heading(title, rows.length)} in {repo}
        </span>
      )}
      {rows.map(({ row, open, action }) => (
        <div key={row.number} className={cn("rounded-xl p-3.5", SURFACE)}>
          <button type="button" onClick={open} className="group block w-full cursor-pointer text-left">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StateIcon row={row} />
              <span className="truncate">
                {repo} <span className="tabular-nums">#{row.number}</span>
              </span>
            </span>
            <span className="mt-1.5 block text-chat font-medium group-hover:underline">{row.title}</span>
            {row.excerpt && <span className="mt-1 line-clamp-2 block text-ui text-muted-foreground">{row.excerpt}</span>}
          </button>
          <div className="mt-3 flex items-center gap-2">
            {row.author && (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Avatar src={row.author.avatar} name={row.author.name} className="size-4" />
                <span className="truncate">{row.author.name}</span>
              </span>
            )}
            <Labels labels={row.labels} max={3} />
            <span className="ml-auto">{action}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/// C: one tight card, a single line per issue, labels as dots.
function Compact({ title, repo, rows }: { title: string | null; repo: string; rows: Row[] }) {
  const single = rows.length === 1 ? rows[0].row : null;
  return (
    <div className={cn("rounded-xl p-1", SURFACE)}>
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
        <GitHubIcon className="size-3" />
        <span className="truncate">{repo}</span>
        {title && <span className="ml-auto shrink-0">{title}</span>}
      </div>
      <ul>
        {rows.map(({ row, open, action }) => (
          <li key={row.number} className="flex items-center gap-1 rounded-lg hover:bg-[var(--fill-soft,var(--muted))]">
            <button type="button" onClick={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-ui">
              <StateIcon row={row} />
              <span className="shrink-0 text-muted-foreground tabular-nums">#{row.number}</span>
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              {row.labels.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex shrink-0 items-center gap-0.5">
                      {row.labels.slice(0, 4).map((label) => (
                        <IssueLabelChip key={label.name} label={label} dot />
                      ))}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{row.labels.map((l) => l.name).join(", ")}</TooltipContent>
                </Tooltip>
              )}
            </button>
            {/* One width for Work on it, Started and nothing, so the rows line up. */}
            <span className="flex w-24 shrink-0 justify-end pr-1">{action}</span>
          </li>
        ))}
      </ul>
      {/* Padding outside the clamp, or the clipped third line shows in it. */}
      {single?.excerpt && (
        <div className="px-2.5 pb-2">
          <p className="line-clamp-2 text-xs text-muted-foreground">{single.excerpt}</p>
        </div>
      )}
    </div>
  );
}

function StateIcon({ row, className }: { row: IssueCardRow; className?: string }) {
  return (
    <IssueStateIcon
      kind={row.closed ? "completed" : "unstarted"}
      // GitHub's own two, as `states()` in github.rs gives the issues page.
      color={row.closed ? "#8250df" : "#1a7f37"}
      label={row.closed ? "Closed" : "Open"}
      className={className}
    />
  );
}

function Labels({ labels, max }: { labels: IssueLabel[]; max: number }) {
  if (labels.length === 0) return null;
  const extra = labels.length - max;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {labels.slice(0, max).map((label) => (
        <IssueLabelChip key={label.name} label={label} className="max-w-28 truncate text-xs" />
      ))}
      {extra > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground" title={labels.slice(max).map((l) => l.name).join(", ")}>
          +{extra}
        </span>
      )}
    </span>
  );
}

/// Work on it: hands the issue to the agent, then says Started. Nothing for a
/// closed issue or a settled chat, unless it was already started.
function WorkOn({
  event,
  row,
  started,
  closed,
  look,
}: {
  event: AgentEvent;
  row: IssueCardRow;
  started: boolean;
  closed: boolean;
  look: Design;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (started) {
    return (
      // Inset like the ghost button it replaces in C, so the two line up.
      <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground", look === "compact" && "px-2")}>
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

  const button = (
    <Button
      variant={look === "cards" ? "secondary" : look === "compact" ? "ghost" : "outline"}
      size="xs"
      disabled={sending}
      onClick={() => void start()}
      className={cn("shrink-0", error && "text-destructive")}
    >
      {sending && <Spinner className="size-3" />}
      {sending ? "Starting…" : error ? "Retry" : "Work on it"}
    </Button>
  );
  if (!error) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>Couldn't start: {error}</TooltipContent>
    </Tooltip>
  );
}
