import { Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RUN_SERVER_PROMPT } from "@/lib/runServer";

/// Sends [RUN_SERVER_PROMPT] as an ordinary prompt — the HandoffRow bargain, in
/// the toolbar rather than parked behind it. A click is the reader typing
/// "start the dev server" without typing it, and what it removes is a `cd`: a
/// session's worktree sits at `<project>/.claude/worktrees/<name>`, a path that
/// had to be found and pasted into a terminal once per session.
///
/// **No Stop beside it, and none wanted.** The server arrives as a `local_bash`
/// background task, so the orb under the transcript already says one is running
/// and the subagent panel already stops it. A second stop here would be a
/// second owner of one process.
///
/// Nothing guards a second press. A send during a turn queues like any other,
/// so the second one lands in a fresh turn where the agent can see its own
/// server already running and say so.
export default function RunServerButton({
  onSend,
}: {
  onSend: (prompt: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onSend(RUN_SERVER_PROMPT)}
          aria-label="Run server"
          className="text-muted-foreground"
        >
          <Play />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Run server</TooltipContent>
    </Tooltip>
  );
}
