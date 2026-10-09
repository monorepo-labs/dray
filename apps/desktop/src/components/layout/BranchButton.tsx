import { displayPath } from "@/lib/transport";
import { Check, FolderGit2 } from "lucide-react";

import GitBranchIcon from "@/components/icons/GitBranchIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopied } from "@/hooks/useCopied";

/// The branch the session's work lands on, with the git mark; a click copies
/// the working directory. Drawn at the far end of the titlebar's tab row.
export default function BranchButton({ branch, cwd: rawCwd }: { branch: string; cwd: string }) {
  const [copiedPath, copy] = useCopied();
  // The branch is what's drawn, the directory is what gets copied — a name is
  // a thing to read, a path is a thing to paste into a terminal, and a
  // worktree session's two differ.
  const cwd = displayPath(rawCwd);
  const copied = copiedPath === cwd;
  // Read off the directory rather than the branch name, which a reader can
  // rename to anything; Dray's trees always live under this segment.
  const worktree = rawCwd.includes("/.claude/worktrees/");
  const Mark = worktree ? FolderGit2 : GitBranchIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copy(cwd)}
          aria-label={`Copy the working directory, ${cwd}`}
          // Shrinkable, not `shrink-0`: a worktree branch name is long and
          // unbounded, so a fixed one overflowed the row and drew itself
          // over the view tabs rather than giving up width.
          className="flex min-w-0 cursor-pointer items-center gap-1 rounded-md text-muted-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {copied ? (
            <Check className="size-3.5 shrink-0" />
          ) : (
            <Mark className="size-3.5 shrink-0" />
          )}
          {/* A Dray worktree's branch is `worktree-<name>`; the mark already
              says worktree and the name is the part worth the room. */}
          <span className="truncate">{branch.replace(/^worktree-/, "")}</span>
        </button>
      </TooltipTrigger>
      {/* What it is and what the click does, not the path itself: a long path
          drawn on every hover buries both. It is on the clipboard a click later. */}
      <TooltipContent>
        {copied
          ? "Copied"
          : `${worktree ? "Worktree" : "Branch"} · click to copy the working directory`}
      </TooltipContent>
    </Tooltip>
  );
}
