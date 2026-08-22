import GitBranchIcon from "@/components/icons/GitBranchIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename } from "@/lib/format";
import { sessionBranch } from "@/lib/pr";
import { cn } from "@/lib/utils";
import type { SessionSnapshot } from "@/types/events";

type SessionHeaderProps = {
  session: SessionSnapshot | null;
  className?: string;
};

/// One line: `project / title`, then the branch. The sidebar clips titles at
/// 240px, so this is the one place the full one is legible — hence the tooltip,
/// and hence the title being the only part that gives way to truncation.
export default function SessionHeader({ session, className }: SessionHeaderProps) {
  if (!session) {
    return (
      <div className={cn("min-w-0", className)}>
        <span className="text-ui text-muted-foreground">New session</span>
      </div>
    );
  }

  // A worktree session's `cwd` is the tree, not the repo, so the project name
  // has to come off `projectPath` or every worktree reads as its own project.
  const project = basename(session.projectPath);
  const branch = sessionBranch(session);

  return (
    <div className={cn("flex min-w-0 items-center gap-3 text-ui", className)}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">{project}</span>
        <span aria-hidden className="shrink-0 text-muted-foreground/50">
          /
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate font-medium text-foreground">{session.title}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-80 text-balance">
            {session.title}
          </TooltipContent>
        </Tooltip>
      </span>

      {branch && (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <GitBranchIcon className="size-3.5 shrink-0" />
          {branch}
        </span>
      )}
    </div>
  );
}
