import { GitPullRequest } from "lucide-react";

import Orb from "@/components/Orb";
import { ChecksRunningIcon } from "@/components/PrStateIcon";
import type { TaskCounts } from "@/components/TasksPanel";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/// A bot's tasks at a glance, at the composer row's right end where a
/// session's context ring sits: working, ready to merge, checks running, and
/// the rest as one grey number — or, when only the rest remain, a blinking
/// idle orb and their count. A zero says nothing, and no tasks draws nothing.
/// Opens the side panel on Tasks.
export default function TaskStatus({ counts, onOpen }: { counts: TaskCounts; onOpen: () => void }) {
  const { working, ready, checks, other } = counts;
  const shown = working + ready + checks;
  if (shown + other === 0) return null;

  const spelled = [
    working > 0 && `${working} working`,
    ready > 0 && `${ready} ready to merge`,
    checks > 0 && `${checks} with checks running`,
    other > 0 && (shown > 0 ? `${other} other ${other === 1 ? "task" : "tasks"}` : plural(other, "idle task")),
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${spelled.join(", ")}. Open Tasks.`}
      className="flex shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 text-[12px] leading-4 font-medium tabular-nums outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {working > 0 && (
        <span className="flex items-center gap-1 text-foreground">
          <Orb state="working" size={14} />
          {working}
        </span>
      )}
      {/* The Tasks tab's ready rows draw this glyph in this green. */}
      {ready > 0 && (
        <span className="flex items-center gap-1 text-accent-add">
          <GitPullRequest className="size-[13px]" strokeWidth={2} aria-hidden />
          {ready}
        </span>
      )}
      {/* The spinner keeps its own yellow and the number stays grey: yellow
          text is what a task waiting on the reader wears. */}
      {checks > 0 && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <ChecksRunningIcon className="size-[13px]" />
          {checks}
        </span>
      )}
      {other > 0 &&
        (shown > 0 ? (
          <span className="text-muted-foreground">+{other}</span>
        ) : (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Orb state="idle" variant="blink" size={14} className="text-muted-foreground" />
            {other}
          </span>
        ))}
    </button>
  );
}
