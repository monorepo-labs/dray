import { useSyncExternalStore, type ReactNode } from "react";
import { ListChecks, SquareTerminal } from "lucide-react";

import BotAvatar from "@/components/BotAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { seededAvatar } from "@/lib/botAvatar";
import { cn } from "@/lib/utils";
import type { Bot, SessionIndexItem } from "@/types/events";

/// The takes on the chip's icon, picked in a dev build until one is chosen:
/// the task's own face, a terminal, a checklist.
export const TASK_ICONS = ["face", "terminal", "checklist"] as const;
export type TaskIcon = (typeof TASK_ICONS)[number];

const ICON_KEY = "dray.dev.taskChipIcon";
let icon: TaskIcon = readLocalStorage<TaskIcon>(ICON_KEY, "face");
const listeners = new Set<() => void>();

export function setTaskIcon(next: TaskIcon) {
  icon = next;
  writeLocalStorage(ICON_KEY, next);
  for (const l of listeners) l();
}

export function useTaskIcon(): TaskIcon {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => icon,
  );
}

/// A task's mark in the chip: its face (a bot's task wears its bot's), or the
/// picked glyph.
function Mark({ task, bot, kind }: { task: SessionIndexItem; bot: Bot | undefined; kind: TaskIcon }): ReactNode {
  if (kind === "terminal") return <SquareTerminal className="size-3" />;
  if (kind === "checklist") return <ListChecks className="size-3" />;
  return bot ? (
    <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-3.5 scale-[1.18]" />
  ) : (
    <BotAvatar seed={task.sessionId} avatar={seededAvatar(task.sessionId)} className="block size-3.5 scale-[1.18]" />
  );
}

/// Tasks linked to a row's issue or pull request, as a chip shaped like the
/// issue row's PR chip. One task opens on a click, several open a menu. A span
/// with `role="button"`, since the rows it sits in are `role="button"` divs.
export default function TaskChip({
  tasks,
  botOf,
  onOpen,
  className,
}: {
  /// Newest first.
  tasks: SessionIndexItem[];
  botOf: (item: SessionIndexItem) => Bot | undefined;
  onOpen: (item: SessionIndexItem) => void;
  className?: string;
}) {
  const kind = useTaskIcon();
  if (tasks.length === 0) return null;
  const latest = tasks[0];
  const chip = (props: React.HTMLAttributes<HTMLSpanElement>) => (
    <span
      role="button"
      tabIndex={0}
      {...props}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 py-px text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
        className,
      )}
    >
      <Mark task={latest} bot={botOf(latest)} kind={kind} />
      {tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}
    </span>
  );

  if (tasks.length === 1) {
    const open = (e: React.SyntheticEvent) => {
      e.stopPropagation();
      onOpen(latest);
    };
    return chip({
      title: latest.title,
      onClick: open,
      onKeyDown: (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open(e);
      },
    });
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* The row under it opens on a click that reaches it. */}
        <span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {chip({})}
        </span>
      </DropdownMenuTrigger>
      {/* React events bubble through the portal to the row. */}
      <DropdownMenuContent align="end" className="w-72" onClick={(e) => e.stopPropagation()}>
        {tasks.map((task) => {
          const bot = botOf(task);
          return (
            <DropdownMenuItem key={task.sessionId} onSelect={() => onOpen(task)}>
              <Mark task={task} bot={bot} kind="face" />
              <span className="min-w-0 flex-1 truncate">{bot ? `${bot.name} · ${task.title}` : task.title}</span>
              {task.archived && <span className="shrink-0 text-muted-foreground">Settled</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// The dev build's switch between the icon takes, until one is picked.
export function TaskIconSwitch() {
  const kind = useTaskIcon();
  if (!import.meta.env.DEV) return null;
  return (
    <div className="pointer-events-auto fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-popover p-1 text-xs text-muted-foreground shadow-[var(--shadow-card)]">
      <span className="px-1.5">Task icon</span>
      {TASK_ICONS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setTaskIcon(k)}
          className={cn("rounded-md px-2 py-1 capitalize", k === kind ? "bg-sidebar-accent text-foreground" : "hover:bg-sidebar-accent/50")}
        >
          {k}
        </button>
      ))}
    </div>
  );
}
