import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

import GitBranchIcon from "@/components/icons/GitBranchIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SessionSnapshot } from "@/types/events";

type SessionHeaderProps = {
  session: SessionSnapshot | null;
  /// What the main column is showing, when it is not a session. The issues page
  /// fills that column but is not a session and never becomes one, so the
  /// header would otherwise sit at "New session" while a list of issues is on
  /// screen — naming a thing the reader is not looking at.
  standIn?: string | null;
  /// What `sessionBranch` made of this session, handed in rather than worked
  /// out again here: `App` has git's own reading of HEAD to give it, and a
  /// header naming one branch while the PR tab looks up another is the whole
  /// of the bug that rule exists to stop.
  branch: string | null;
  className?: string;
};

/// How long the button holds its confirmation, matching the notice stack's own.
const COPIED_MS = 1400;

/// One line: `project / title`, then the branch. The title is the only part
/// that gives way to truncation, since it is the one thing here the reader
/// wrote and can recognise from its opening words.
///
/// No tooltip on it. It fired on every hover of a title that was not clipped,
/// which is most of them, and repeated back text already on screen — the one
/// thing the app's tooltip rule says a tooltip must not do.
export default function SessionHeader({
  session,
  branch,
  standIn,
  className,
}: SessionHeaderProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (standIn || !session) {
    return (
      <div className={cn("min-w-0", className)}>
        <span className="text-ui text-muted-foreground">{standIn ?? "New session"}</span>
      </div>
    );
  }

  // A worktree session's `cwd` is the tree, not the repo, so the project name
  // has to come off `projectPath` or every worktree reads as its own project.
  const project = basename(session.projectPath);

  // The branch is what's drawn, the directory is what gets copied — a name is
  // a thing to read, a path is a thing to paste into a terminal, and a
  // worktree session's two differ.
  const cwd = session.cwd;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cwd);
    } catch (err) {
      console.error("failed to copy the working directory", err);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-3 text-ui", className)}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">{project}</span>
        <span aria-hidden className="shrink-0 text-muted-foreground/50">
          /
        </span>

        <span className="truncate font-medium text-foreground">{session.title}</span>
      </span>

      {branch && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={`Copy the working directory, ${cwd}`}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md text-muted-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {copied ? (
                <Check className="size-3.5 shrink-0" />
              ) : (
                <GitBranchIcon className="size-3.5 shrink-0" />
              )}
              {branch}
            </button>
          </TooltipTrigger>
          {/* The path, because it is the thing being copied and the one thing
              here that is not already on screen. */}
          <TooltipContent className="max-w-sm break-all">
            {copied ? "Copied" : cwd}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
