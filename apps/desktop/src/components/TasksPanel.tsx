import { Check, ChevronDown, CornerDownRight, Ellipsis } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";

import BotAvatar from "@/components/BotAvatar";
import MachineMark from "@/components/MachineMark";
import Orb from "@/components/Orb";
import { MERGE_FILL, METHOD_DETAIL, METHOD_LABEL, TONE_TEXT } from "@/components/PrPanel";
import PrStateIcon, { ChecksRunningIcon } from "@/components/PrStateIcon";
import { RowAction, RowMenu, stageRuns } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { useFixAsks } from "@/hooks/useFixAsks";
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
import { isModClick } from "@/lib/platform";
import { prStatus, readyToMerge, type PrStatusKey } from "@/lib/pr";
import { serverName, useServers } from "@/lib/servers";
import { LOCAL, serverOfPath } from "@/lib/transport";
import { fixLine, type FixAsk } from "@/lib/stalled";
import { cn } from "@/lib/utils";
import type { MergeMethod, PrMark } from "@/types/events";

type Flags = { archived?: boolean; pinned?: boolean; aside?: boolean };

type TaskState = "asking" | "busy" | "idle";

/// What wants the reader, then what works, then what is done — also the order
/// the runs are drawn in. Set aside sinks under all three, as in the sidebar.
const TASK_STATES: TaskState[] = ["asking", "busy", "idle"];

/// Needs you with working, as the sidebar pairs needs you with unread: each
/// row's own mark, yellow title or orb, tells them apart.
const SHARED_BREAKS: TaskState[][] = [["asking", "busy"]];

/// A run takes the strongest state in it, which only matters for the one run
/// a short list draws.
const taskState = (rows: CrewRow[]): TaskState =>
  rows.some((r) => r.asking) ? "asking" : rows.some((r) => r.busy || r.background) ? "busy" : "idle";

/// The Pinned rows, then the runs drawn under them with a break between each.
/// Sorted by state first, since a short list draws as one run and would
/// otherwise keep newest-first, an idle task above one waiting on the reader.
export function taskRuns(rows: CrewRow[]): { pinned: CrewRow[]; runs: CrewRow[][] } {
  const rank = (r: CrewRow) => TASK_STATES.indexOf(taskState([r]));
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b));
  // Pinned under its own heading, as the sidebar draws it. Setting aside
  // unpins, so the two never meet.
  const pinned = sorted.filter((r) => r.item.pinned && !r.item.aside);
  const aside = sorted.filter((r) => r.item.aside);
  const byState = stageRuns(
    sorted.filter((r) => !r.item.aside && !pinned.includes(r)).map((r) => [r]),
    taskState,
    SHARED_BREAKS,
  );
  const runs = [...TASK_STATES.map((s) => byState.get(s) ?? []), aside].filter((run) => run.length);
  return { pinned, runs };
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
  onFixConflicts,
  now,
}: {
  rows: CrewRow[];
  /// The pull request a task's branch carries, for the mark the sidebar draws.
  prOf: (row: CrewRow) => PrMark | undefined;
  /// `alone`: a ⌘-click, which switches to the task rather than opening its tab.
  onOpen: (sessionId: string, alone: boolean) => void;
  onSetFlags: (sessionId: string, flags: Flags) => Promise<void>;
  onFork: (sessionId: string, worktree: boolean) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onDetach: (sessionId: string) => Promise<void>;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
  /// Asks the task's own agent, which holds the branch, to resolve and push.
  onFixConflicts: (row: CrewRow, pr: PrMark) => Promise<void>;
  /// The clock a fix's age is read against, ticking once a minute.
  now: number;
}) {
  const fixAsks = useFixAsks();
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-ui text-muted-foreground">
        Nothing handed off yet. Work this bot starts shows up here.
      </p>
    );
  }

  const { pinned, runs } = taskRuns(rows);
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
      onFixConflicts={onFixConflicts}
      fixAsk={fixAsks[row.item.sessionId]}
      now={now}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-2">
      {pinned.length > 0 && (
        <>
          <div className="flex min-h-6 items-center px-2 text-ui text-muted-foreground/70">Pinned</div>
          {pinned.map(draw)}
        </>
      )}
      {/* The sidebar's break between runs, `shrink-0` so it survives overflow.
          Rows keep their keys across runs, so a task changing state moves. */}
      {runs.flatMap((run, i) => [
        (i > 0 || pinned.length > 0) && <div key={`gap ${i}`} aria-hidden className="h-4 shrink-0" />,
        ...run.map(draw),
      ])}
    </div>
  );
}

/// States a row says without words: the PR glyph carries merged, closed, draft
/// and red checks, the spinner running ones, Merge the rest. Conflicts take
/// words while Fix conflicts is off; put `conflict` back here with it.
/// `unknown` is a few seconds' recompute, not worth a flicker.
const DRAWN = new Set<PrStatusKey>(["merged", "closed", "draft", "checksFailing", "checksRunning", "ready", "unknown"]);

function TaskRow({
  row,
  pr,
  onOpen,
  onSetFlags,
  onFork,
  onDelete,
  onDetach,
  onMerge,
  fixAsk,
  now,
}: {
  row: CrewRow;
  pr: PrMark | undefined;
  onOpen: (sessionId: string, alone: boolean) => void;
  onSetFlags: (sessionId: string, flags: Flags) => Promise<void>;
  onFork: (sessionId: string, worktree: boolean) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onDetach: (sessionId: string) => Promise<void>;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
  onFixConflicts: (row: CrewRow, pr: PrMark) => Promise<void>;
  fixAsk: FixAsk | undefined;
  now: number;
}) {
  const [hovered, setHovered] = useState(false);
  // Read for the re-render alone: a server renamed moves the name in the row's tooltip.
  useServers();
  const { item } = row;
  const server = serverOfPath(item.projectPath);
  const machine = server !== LOCAL ? serverName(server) : null;
  const id = item.sessionId;
  const working = row.busy && !row.asking;
  const mergeable = pr?.state === "OPEN" && !pr.isDraft && readyToMerge(pr) === true;
  // Merging here or from a merge card settles already, so the button is only
  // for a PR merged elsewhere, say the PR panel in the task's own tab. Never
  // mid-turn either way: settling kills the child.
  const settleShown = pr?.state === "MERGED" && !row.busy;
  const settle = (from?: HTMLElement) => {
    if (from) burstConfetti(from);
    void onSetFlags(id, { archived: true });
  };
  const status = pr && prStatus(pr);
  // Words only where the glyph, the spinner or a button cannot say it.
  const words = status && !DRAWN.has(status.key) ? status : null;
  const fixing = fixLine(fixAsk, pr, now);

  return (
    <RowMenu
      onFork={(worktree) => void onFork(id, worktree)}
      forkDisabled={row.busy}
      onDelete={() => void onDelete(id)}
      onDetach={() => void onDetach(id)}
      onSettle={row.busy ? undefined : () => settle()}
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
        onClick={(e) => onOpen(id, isModClick(e))}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(id, isModClick(e))}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className={cn(
          "group flex w-full cursor-pointer flex-col rounded-md px-2 text-left text-ui text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/50",
          item.aside && "opacity-50",
        )}
      >
        <span className="flex h-8 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {working ? (
            <Orb state="working" label="Working" />
          ) : row.background ? (
            <Orb state="background" variant="spiral" label="Background tasks running" />
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
              "min-w-0 flex-1 truncate",
              settleShown
                ? "row-reached:[mask-image:linear-gradient(to_left,transparent_52px,black_76px)]"
                : "row-reached:[mask-image:linear-gradient(to_left,transparent_26px,black_50px)]",
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
            {settleShown && (
              <RowAction label="Settle" active={false} onClick={(e) => settle(e.currentTarget)}>
                <Check />
              </RowAction>
            )}
          </span>
        </span>

        <MachineMark machine={machine} />

        {words && <span className={cn("shrink-0 text-[12px]", TONE_TEXT[words.tone])}>{words.label}</span>}

        {/* Opens the pull request in Dray's browser; ⌘-click, the system's. */}
        {pr && status && (
          <button
            type="button"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-0.5 text-[12px] text-muted-foreground tabular-nums hover:text-foreground"
            title={`Pull request #${pr.number} · ${status.label.toLowerCase()}`}
            onClick={(e) => {
              e.stopPropagation();
              if (pr.url) openLink(pr.url, e);
            }}
          >
            {status.key === "checksRunning" ? <ChecksRunningIcon /> : <PrStateIcon pr={pr} strokeWidth={1.5} />}
            <span>#{pr.number}</span>
          </button>
        )}

        {mergeable && pr && <MergeControl onMerge={(method) => onMerge(row, pr, method)} />}
        {/* Off while the bot fixes conflicts itself, on its nudge. */}
        {/* {status?.key === "conflict" && pr && <FixConflicts onFix={() => onFixConflicts(row, pr)} />} */}
        </span>
        {/* Under the title, past the face's 20px and the 8px gap. */}
        {(fixing || row.from !== undefined) && (
          <span className="-mt-1 flex min-w-0 flex-col pb-1.5 pl-7">
            {row.from !== undefined && (
              <span
                className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground/70"
                title={`Started by ${row.from || "Untitled"}`}
              >
                <CornerDownRight aria-hidden className="size-3 shrink-0" />
                <span className="sr-only">Started by</span>
                <span className="truncate">{row.from || "Untitled"}</span>
              </span>
            )}
            {fixing && <span className="truncate text-ui text-foreground/50">{fixing}</span>}
          </span>
        )}
      </div>
    </RowMenu>
  );
}

type MergeRun = { merging: boolean; error: string | null };
const IDLE: MergeRun = { merging: false, error: null };
/// Merges in flight and their failures, outside the component: a merge card
/// can remount mid-merge when a queued prompt regroups its turn, and a merge
/// already sent must not offer its button again or lose its error.
const runs = new Map<string, MergeRun>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function setRun(key: string, run: MergeRun) {
  if (run === IDLE) runs.delete(key);
  else runs.set(key, run);
  listeners.forEach((l) => l());
}

/// The PR panel's merge, cut to a row: a split button naming the method, and
/// a confirm step, since a merge is the one thing here that cannot be undone.
/// `keep` names the merge across remounts; `named` spells the method out on
/// the button, as the PR panel's does, where there is room for it.
export function MergeControl({
  onMerge,
  keep,
  named = false,
}: {
  onMerge: (method: MergeMethod) => Promise<void>;
  keep?: string;
  named?: boolean;
}) {
  const own = useId();
  const key = keep ?? own;
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [confirming, setConfirming] = useState(false);
  const { merging, error } = useSyncExternalStore(subscribe, () => runs.get(key) ?? IDLE);

  const merge = async () => {
    setConfirming(false);
    setRun(key, { merging: true, error: null });
    try {
      await onMerge(method);
      setRun(key, IDLE);
    } catch (e) {
      setRun(key, { merging: false, error: String(e) });
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
            {named ? `Confirm ${METHOD_LABEL[method].toLowerCase()}` : "Confirm"}
          </Button>
        </>
      ) : (
        <span className="flex items-center rounded-[min(var(--radius-md),10px)] shadow-(--shadow-button)">
          <Button
            size="xs"
            className={cn(MERGE_FILL, "rounded-r-none disabled:opacity-100")}
            disabled={merging}
            title={named ? undefined : METHOD_LABEL[method]}
            onClick={() => setConfirming(true)}
          >
            {merging ? "Merging…" : named ? METHOD_LABEL[method] : "Merge"}
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

/// Merge's stand-in while the PR conflicts with its base: hands the fix to the
/// task's own agent, which holds the branch.
export function FixConflicts({ onFix }: { onFix: () => Promise<void> }) {
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
  // Clicks stop here, so working the button never opens the task.
  return (
    <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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
