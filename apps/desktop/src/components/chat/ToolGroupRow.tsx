import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import EventRow from "@/components/chat/EventRow";
import { countChanges, editSides } from "@/lib/diff";
import { groupLabel, groupVerb } from "@/lib/tools";
import type { ToolGroup } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import type { FileEdit, ToolResult } from "@/types/events";

/// A run of consecutive same-tool calls behind one row. Expanding reveals the
/// individual calls, each still its own independently expandable `ToolCall`.
export default function ToolGroupRow({
  group,
  resultByCallId,
  editsByCallId,
}: {
  group: ToolGroup;
  resultByCallId: Map<string, ToolResult>;
  editsByCallId?: Map<string, FileEdit[]>;
}) {
  const [open, setOpen] = useState(false);

  // Any call still awaiting its result keeps the group live, so a run that
  // collapses mid-flight still shows it is working.
  const pending = group.calls.some(
    (event) =>
      event.payload.type === "tool_call_started" &&
      !resultByCallId.has(event.payload.callId),
  );

  // The run's total `+N -M`, summed from the same per-call counts the rows
  // underneath show, so the header can never disagree with what expanding it
  // reveals. Without this a run of edits collapses to "Edited 1 file · 4 calls"
  // — the count says something happened four times and nothing says how much
  // changed, which is the one number the reader wanted from a collapsed diff.
  //
  // Summing per-call fragment diffs is deliberate. An `Edit` diffs its replaced
  // region rather than the file, so these are region counts and adding them
  // gives the run's total churn — not what `git --stat` would report against the
  // file's original, which no call in the group carries.
  //
  // Keyed on the call count rather than on `calls`: a committed call's input is
  // immutable, so a run can only ever grow, and re-parsing every diff in the
  // group on each of a streaming turn's renders is the cost this avoids.
  const changes = useMemo(() => {
    let added = 0;
    let removed = 0;
    let any = false;

    for (const event of group.calls) {
      const { payload } = event;
      // `rawInput` means the call never parsed as JSON, so there is nothing to
      // diff — it is dropped from the sum rather than counted as zero.
      if (payload.type !== "tool_call_started") continue;
      if (payload.toolType !== "file_edit" || payload.rawInput) continue;

      const sides = editSides(payload.input);
      if (!sides) continue;

      const count = countChanges(sides);
      added += count.added;
      removed += count.removed;
      any = true;
    }

    return any ? { added, removed } : null;
  }, [group.key, group.calls.length]);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="group/group flex w-full items-center gap-2 text-left text-chat text-muted-foreground"
      >
        {/* Styled as the turn summary is, not as a tool row: with the
            double-nesting rule this heads the turn's work where that summary
            otherwise would, so the two must read as the same kind of toggle.
            A failing call inside does not color it: one error among a dozen
            calls would paint the whole run as failed, and the row that failed
            says so itself once the group is expanded. */}
        <span className={cn("shrink-0", pending && "shimmer-text")}>
          {group.target
            ? groupVerb(group.name, pending)
            : groupLabel(group.name, group.targets, pending)}
        </span>

        {/* A run that hit one target names it instead of counting to one, so it
            reads like the `ToolCall` rows underneath — same mono, same truncation
            — with the verb above keeping the group's own styling. */}
        {group.target && (
          <span className="min-w-0 max-w-fit truncate font-mono">{group.target}</span>
        )}

        {/* The label counts targets, so repeat visits vanish from it — 30 edits
            across 12 files reads as "12 files". This is the only place that
            gap is visible, and without it a 3-row group can say "1 file". */}
        {group.calls.length > group.targets && (
          <span className="shrink-0">{group.calls.length} calls</span>
        )}

        {/* Same slot and same styling as the single row's, so a run that grows
            past `GROUP_MIN` doesn't move its own counter when the group forms
            around it. */}
        {changes && (changes.added > 0 || changes.removed > 0) && (
          <span className="shrink-0 font-mono tabular-nums">
            {changes.added > 0 && <span className="text-accent-add">+{changes.added}</span>}
            {changes.added > 0 && changes.removed > 0 && " "}
            {changes.removed > 0 && <span className="text-destructive">-{changes.removed}</span>}
          </span>
        )}

        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-all",
            open ? "rotate-90 opacity-100" : "opacity-0 group-hover/group:opacity-100",
          )}
        />
      </button>

      {/* Indented so the calls read as belonging to the row above rather than
          as siblings that appeared from nowhere. */}
      {open && (
        <div className="flex flex-col gap-1.5 border-l border-border/60 pl-3">
          {group.calls.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              resultByCallId={resultByCallId}
              editsByCallId={editsByCallId}
              hideToolLabel
            />
          ))}
        </div>
      )}
    </div>
  );
}
