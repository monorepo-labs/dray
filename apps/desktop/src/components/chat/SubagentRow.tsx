import { ChevronRight } from "lucide-react";
import Orb from "@/components/Orb";

import type { SubagentRun } from "@/lib/transcript";
import { cn } from "@/lib/utils";

/// The subagent's place in the main conversation: one compact row. It never
/// expands inline — clicking opens the subagent panel, which is where the run's
/// events actually live.
///
/// The row says what the agent is doing and nothing else. Its tool name is
/// harness vocabulary ("Task", "local_bash") that names the mechanism rather
/// than the work, and a step count says something happened without saying what.
export default function SubagentRow({
  run,
  onOpen,
}: {
  run: SubagentRun;
  onOpen: (id: string) => void;
}) {
  // While running, `status` is rewritten per progress event, so it reads as a
  // live status line without opening anything. The label is the floor — a run
  // that reported no description still needs something clickable.
  const detail =
    (run.done ? run.description : run.status ?? run.description) ??
    run.label ??
    "Subagent";

  // A run in the background is not work the reader is waiting on: the tasks
  // indicator already says it is up, and a dev server would shimmer forever.
  const running = !run.done && !run.background;

  return (
    <button
      type="button"
      onClick={() => onOpen(run.id)}
      className="group flex w-full cursor-pointer items-center gap-2 text-left text-chat"
    >
      {/* The orb *is* the running state, so it goes when the run ends rather
          than settling into a resting pose — a still orb next to a finished run
          reads as something that stalled. Same size and pinned theme as
          `WorkingIndicator`, which is the other place it appears inline. */}
      {running && <Orb state="listening" size={20} aria-hidden />}

      <span
        className={cn(
          "min-w-0 max-w-fit truncate",
          running ? "shimmer-text" : "text-muted-foreground",
        )}
      >
        {detail}
      </span>

      <ChevronRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
