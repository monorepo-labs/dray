import type { ReactNode } from "react";
import { ChatBubbleOvalLeftIcon } from "@heroicons/react/16/solid";

import BotAvatar from "@/components/BotAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Bot, SessionIndexItem } from "@/types/events";

/// A task's mark: its bot's face for a bot's task, else the chat bubble a
/// session's tab wears.
function Mark({ bot }: { bot: Bot | undefined }): ReactNode {
  return bot ? (
    <BotAvatar seed={bot.id} avatar={bot.avatar} className="block size-3.5 scale-[1.18]" />
  ) : (
    <ChatBubbleOvalLeftIcon className="size-3 shrink-0" />
  );
}

/// Tasks linked to a row's issue or pull request, as a chip shaped like the
/// issue row's PR chip: the newest task's mark, and a count only past one. One
/// task opens on a click, several open a menu. A span with `role="button"`,
/// since the rows it sits in are `role="button"` divs.
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
  if (tasks.length === 0) return null;
  const latest = tasks[0];
  const bot = botOf(latest);
  const chip = (props: React.HTMLAttributes<HTMLSpanElement>) => (
    <span
      role="button"
      tabIndex={0}
      aria-label={tasks.length === 1 ? `Open task ${latest.title}` : `${tasks.length} tasks`}
      {...props}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border py-px text-muted-foreground tabular-nums transition-colors hover:bg-sidebar-accent hover:text-foreground",
        tasks.length > 1 ? "px-1.5" : "px-1",
        className,
      )}
    >
      <Mark bot={bot} />
      {tasks.length > 1 && tasks.length}
    </span>
  );

  if (tasks.length === 1) {
    const open = (e: React.SyntheticEvent) => {
      e.stopPropagation();
      onOpen(latest);
    };
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {chip({
            onClick: open,
            onKeyDown: (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              open(e);
            },
          })}
        </TooltipTrigger>
        <TooltipContent>{bot ? `${bot.name} · ${latest.title}` : latest.title}</TooltipContent>
      </Tooltip>
    );
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
              <Mark bot={bot} />
              <span className="min-w-0 flex-1 truncate">{bot ? `${bot.name} · ${task.title}` : task.title}</span>
              {task.archived && <span className="shrink-0 text-muted-foreground">Settled</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
