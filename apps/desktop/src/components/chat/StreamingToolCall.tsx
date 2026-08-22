import { ChevronRight } from "lucide-react";

import { streamingLabel, toolLabel } from "@/lib/tools";
import { streamingCall } from "@/lib/streaming";

/// A tool call the model is still composing, drawn from the `block_start` that
/// named it and the argument fragments that have landed since.
///
/// Deliberately a separate component from [ToolCall](./ToolCall.tsx) rather than
/// its `rawInput` path: this row can never expand, so every branch that decides
/// what sits under the header is dead weight here, and keeping the settled row's
/// logic untouched means the preview can't regress it. The markup of the header
/// is kept identical on purpose — this row is replaced by that one mid-stream,
/// and any difference in class or order shows up as a jump at the swap.
export default function StreamingToolCall({
  name,
  partialJson,
}: {
  name: string;
  /// The `input_json_delta` fragments concatenated so far. A prefix of a JSON
  /// object, so it is read rather than parsed.
  partialJson: string;
}) {
  const { target, added } = streamingCall(name, partialJson);

  // The tool's own verb once there is a target to put beside it, matching what
  // the committed row will say. Until then the generic form carries the noun
  // instead, so the row is never just a bare participle.
  const label = target ? toolLabel(name, true) : streamingLabel(name);

  return (
    <div className="flex flex-col gap-1.5">
      {/* A div, not a disabled button: there is nothing under this row to open,
          and a button that never does anything is a focus stop that lies. */}
      <div className="flex w-full items-center gap-2 text-left text-chat">
        <span className="shrink-0 shimmer-text text-foreground/80">{label}</span>

        {target && (
          <span className="min-w-0 max-w-fit truncate font-mono text-muted-foreground">
            {target}
          </span>
        )}

        {/* The same `+N` the settled row shows from its diff, in the same slot,
            so a `Write` that lands doesn't move its own counter. Climbing while
            the content streams is the point — it is the only thing on screen
            that says the wait is progressing rather than stalled. */}
        {added !== null && added > 0 && (
          <span className="shrink-0 font-mono tabular-nums text-emerald-400">+{added}</span>
        )}

        {/* Holds the caret's width so the row doesn't shift left when the
            committed row replaces it with a real, expandable one. */}
        <ChevronRight className="invisible size-3 shrink-0" />
      </div>
    </div>
  );
}
