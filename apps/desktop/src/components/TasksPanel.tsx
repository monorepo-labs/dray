import { Check, ChevronDown, Ellipsis } from "lucide-react";
import { useState } from "react";

import BotAvatar from "@/components/BotAvatar";
import Orb from "@/components/Orb";
import { MERGE_FILL, METHOD_DETAIL, METHOD_LABEL } from "@/components/PrPanel";
import PrStateIcon, { prStateLabel } from "@/components/PrStateIcon";
import { RowAction, RowMenu } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { seededAvatar } from "@/lib/botAvatar";
import { burstConfetti } from "@/lib/confetti";
import type { CrewRow } from "@/lib/crew";
import { openLink } from "@/lib/openLink";
import { readyToMerge } from "@/lib/pr";
import { cn } from "@/lib/utils";
import type { MergeMethod, PrMark } from "@/types/events";

type Flags = { archived?: boolean; pinned?: boolean; aside?: boolean };

/// What wants the reader, then what works, then what is done; set aside last
/// of all, faded, as the sidebar sinks it. Pinned rows are drawn apart.
function rank(row: CrewRow): number {
  if (row.item.aside) return 3;
  return row.asking ? 0 : row.busy ? 1 : 2;
}

/// A bot's Tasks tab: every session it handed work to, at any depth. They run
/// hidden from the sidebar, so this is where they are found and handled: each
/// row takes the sidebar row's menu and Settle, and lands its pull request
/// with a Merge button once GitHub says it can — an agent's own merge is
/// often refused by its permission classifier, so the reader lands them.
export default function TasksPanel({
  rows,
  prOf,
  onOpen,
  onSetFlags,
  onFork,
  onDelete,
  onDetach,
  onMerge,
}: {
  rows: CrewRow[];
  /// The pull request a task's branch carries, for the mark the sidebar draws.
  prOf: (row: CrewRow) => PrMark | undefined;
  onOpen: (sessionId: string) => void;
  onSetFlags: (sessionId: string, flags: Flags) => Promise<void>;
  onFork: (sessionId: string, worktree: boolean) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onDetach: (sessionId: string) => Promise<void>;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-ui text-muted-foreground">
        Nothing handed off yet. Work this bot starts shows up here.
      </p>
    );
  }

  const sorted = [...rows].sort((a, b) => rank(a) - rank(b));
  // Pinned under its own heading, as the sidebar draws it. Setting aside
  // unpins, so the two never meet.
  const pinned = sorted.filter((r) => r.item.pinned && !r.item.aside);
  const rest = sorted.filter((r) => !pinned.includes(r));
  const draw = (row: CrewRow) => (
    <TaskRow
      key={row.item.sessionId}
      row={row}
      pr={prOf(row)}
      onOpen={onOpen}
      onSetFlags={onSetFlags}
      onFork={onFork}
      onDelete={onDelete}
      onDetach={onDetach}
      onMerge={onMerge}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-2">
      {pinned.length > 0 && (
        <>
          <div className="flex min-h-6 items-center px-2 text-ui text-muted-foreground/70">Pinned</div>
          {pinned.map(draw)}
          {/* The sidebar's break between runs. */}
          {rest.length > 0 && <div aria-hidden className="h-4 shrink-0" />}
        </>
      )}
      {rest.map(draw)}
    </div>
  );
}

function TaskRow({
  row,
  pr,
  onOpen,
  onSetFlags,
  onFork,
  onDelete,
  onDetach,
  onMerge,
}: {
  row: CrewRow;
  pr: PrMark | undefined;
  onOpen: (sessionId: string) => void;
  onSetFlags: (sessionId: string, flags: Flags) => Promise<void>;
  onFork: (sessionId: string, worktree: boolean) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onDetach: (sessionId: string) => Promise<void>;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  const [hovered, setHovered] = useState(false);
  const { item } = row;
  const id = item.sessionId;
  const working = row.busy && !row.asking;
  const mergeable = pr?.state === "OPEN" && !pr.isDraft && readyToMerge(pr) === true;

  return (
    <RowMenu
      onFork={(worktree) => void onFork(id, worktree)}
      forkDisabled={row.busy}
      onDelete={() => void onDelete(id)}
      onDetach={() => void onDetach(id)}
      aside={!!item.aside}
      // Setting aside unpins, or the row would stay up top.
      onSetAside={(v) => void onSetFlags(id, v ? { aside: true, pinned: false } : { aside: false })}
      pin={{
        pinned: !!item.pinned,
        toggle: () => void onSetFlags(id, item.aside && !item.pinned ? { pinned: true, aside: false } : { pinned: !item.pinned }),
      }}
    >
      {/* A div, since a button cannot hold the buttons inside it. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(id)}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(id)}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className={cn(
          "group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/50",
          item.aside && "opacity-50",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          {working ? (
            <Orb state="working" variant="gyro" size={18} label="Working" />
          ) : (
            <BotAvatar seed={id} avatar={seededAvatar(id)} follow={hovered} className="block size-5 scale-[1.18]" />
          )}
        </span>
        {/* ⋯ and Settle float over the title's tail, which fades out under
            them, rather than taking room of their own: taking it pushed the
            pull request and Merge along under the cursor on every hover. */}
        <span className="relative flex min-w-0 flex-1 items-center">
          <span
            className={cn(
              "min-w-0 flex-1 truncate row-reached:[mask-image:linear-gradient(to_left,transparent_52px,black_76px)]",
              row.asking && "text-accent-command",
            )}
          >
            {item.title}
          </span>
          {row.asking && <span className="sr-only">Waiting for you</span>}
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 row-reached:pointer-events-auto row-reached:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="More"
              className="text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.dispatchEvent(
                  new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }),
                );
              }}
            >
              <Ellipsis />
            </Button>
            {/* No Settle mid-turn: settling kills the child. */}
            {!row.busy && (
              <RowAction
                label="Settle"
                active={false}
                onClick={(e) => {
                  burstConfetti(e.currentTarget);
                  void onSetFlags(id, { archived: true });
                }}
              >
                <Check />
              </RowAction>
            )}
          </span>
        </span>

        {/* Opens the pull request in Dray's browser; ⌘-click, the system's. */}
        {pr && (
          <button
            type="button"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-0.5 text-[12px] text-muted-foreground tabular-nums hover:text-foreground"
            title={`Pull request #${pr.number} · ${prStateLabel(pr).toLowerCase()}`}
            onClick={(e) => {
              e.stopPropagation();
              if (pr.url) openLink(pr.url, e);
            }}
          >
            <PrStateIcon pr={pr} strokeWidth={1.5} />#{pr.number}
          </button>
        )}

        {mergeable && pr && <MergeControl onMerge={(method) => onMerge(row, pr, method)} />}
      </div>
    </RowMenu>
  );
}

/// The PR panel's merge, cut to a row: a split button naming the method, and
/// a confirm step, since a merge is the one thing here that cannot be undone.
function MergeControl({ onMerge }: { onMerge: (method: MergeMethod) => Promise<void> }) {
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merge = async () => {
    setConfirming(false);
    setMerging(true);
    setError(null);
    try {
      await onMerge(method);
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(false);
    }
  };

  // Clicks stop here, so working the control never opens the task.
  return (
    <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {error && (
        <span className="text-[12px] text-destructive" title={error}>
          Failed
        </span>
      )}
      {confirming ? (
        <>
          <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="xs" className={cn(MERGE_FILL, "shadow-(--shadow-button)")} onClick={() => void merge()}>
            Confirm
          </Button>
        </>
      ) : (
        <span className="flex items-center rounded-[min(var(--radius-md),10px)] shadow-(--shadow-button)">
          <Button
            size="xs"
            className={cn(MERGE_FILL, "rounded-r-none disabled:opacity-100")}
            disabled={merging}
            title={METHOD_LABEL[method]}
            onClick={() => setConfirming(true)}
          >
            {merging ? "Merging…" : "Merge"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="xs"
                className={cn(MERGE_FILL, "rounded-l-none px-1 shadow-(--accent-merge-seam) disabled:opacity-100")}
                disabled={merging}
                aria-label="Merge method"
              >
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              {(["squash", "merge", "rebase"] as const).map((value) => (
                <DropdownMenuItem key={value} onSelect={() => setMethod(value)} className="flex-col items-start gap-0">
                  <span className="flex w-full items-center">
                    {METHOD_LABEL[value]}
                    {method === value && <Check className="ml-auto size-3.5" />}
                  </span>
                  <span className="text-ui text-muted-foreground">{METHOD_DETAIL[value]}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </span>
  );
}
